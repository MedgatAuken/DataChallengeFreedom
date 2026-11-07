#!/usr/bin/env node
// Локальный сервер CQA: раздаёт фронтенд, проксирует API организаторов (обход CORS)
// и запускает оценку диалогов через LLM (evaluator.js). Нужен Node.js 18+ и `npm install`.
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { DATA_DIR, DEFAULT_GROUP_ID, FRONTEND_DIR, PORT, STORE_DIR } from './config.js';
import { assertGroupId, fetchDataset, loadDataset, syncDataset } from './fetch_dataset.js';
import { evaluateConversation, loadChecklist } from './evaluator.js';

// ---------- утилиты ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req, limit = 5 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, 'Слишком большой запрос');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Тело запроса не является корректным JSON');
  }
}

// ---------- хранилище (JSON-файлы: чек-листы, оценки, апелляции) ----------

const COLLECTIONS = new Set(['checklists', 'evaluations', 'appeals']);
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

async function readCollection(name) {
  const file = join(STORE_DIR, `${name}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // Первый запуск: чек-листы инициализируются из PDF-конфигурации организаторов.
    if (name === 'checklists') {
      const def = JSON.parse(await readFile(join(DATA_DIR, 'checklist_default.json'), 'utf8'));
      return { [def.id]: def };
    }
    return {};
  }
}

async function writeCollection(name, docs) {
  await mkdir(STORE_DIR, { recursive: true });
  await writeFile(join(STORE_DIR, `${name}.json`), JSON.stringify(docs, null, 2), 'utf8');
}

// ---------- кэш наборов в памяти ----------

const datasets = new Map(); // groupId -> payload

async function getDataset(groupId) {
  if (datasets.has(groupId)) return datasets.get(groupId);
  const payload = await loadDataset(groupId);
  if (!payload) {
    throw httpError(404, `Набор ${groupId} ещё не скачан. Нажмите «Обновить из API» или выполните: npm run fetch -- ${groupId}`);
  }
  datasets.set(groupId, payload);
  return payload;
}

// ---------- запись звонка ----------
// audio_url возвращает HTML-страницу плеера, внутри <source src="..."> — подписанная ссылка
// на mp3, действующая ~1 час. Сервер достаёт эту ссылку и перенаправляет на неё браузер,
// чтобы фронтенд мог использовать свой <audio> и перематывать к нужной реплике.

const audioCache = new Map(); // conversation_id -> { url, expires }

async function resolveAudioUrl(playerUrl) {
  const res = await fetch(playerUrl, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw httpError(502, `Плеер записи ответил HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (type.startsWith('audio/')) return playerUrl; // если когда-нибудь отдадут файл напрямую
  const html = await res.text();
  const m = html.match(/<source[^>]+src="([^"]+)"/i) || html.match(/<audio[^>]+src="([^"]+)"/i);
  if (!m) throw httpError(502, 'Не удалось найти ссылку на аудио на странице плеера');
  return m[1].replace(/&amp;/g, '&');
}

// ---------- оценка ----------

const evaluationsInFlight = new Map(); // ключ -> Promise, чтобы двойной клик не запускал оценку дважды

// Ответ модели («Да»/«Нет»/«N/A»/балл) -> формат ответа, который использует фронтенд.
function toAnswerValue(v) {
  if (v === 'Да') return true;
  if (v === 'Нет') return false;
  if (v === 'N/A') return 'NA';
  return v;
}

function toEvaluationDoc(ev, groupId) {
  const answers = {};
  for (const r of ev.итог.критерии) {
    answers[r.id] = {
      value: toAnswerValue(r.оценка),
      explanation: r.обоснование,
      quote: r.реплика_доказательство,
      evidence: r.номера_реплик,
      checked_range: r.проверенный_участок.length ? [r.проверенный_участок[0], r.проверенный_участок.at(-1)] : null,
    };
  }
  return {
    id: `${groupId}__${ev.conversation_id}__${ev.checklist_id}`,
    group_id: groupId,
    conversation_id: ev.conversation_id,
    checklist_id: ev.checklist_id,
    checklist_version: ev.checklist_version,
    answers,
    summary: ev.оценка_llm.резюме,
    total: ev.итог.итоговый_балл,
    has_critical: ev.итог.грубая_ошибка,
    model: ev.модель,
    attempts: ev.попыток,
    duration_sec: ev.время_сек,
    cost: ev.стоимость,
    source: 'llm',
  };
}

// ---------- маршруты API ----------

async function handleApi(req, res, url) {
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const groupId = assertGroupId(url.searchParams.get('group_id') || DEFAULT_GROUP_ID);
  const method = req.method;

  // GET /api/health
  if (parts[0] === 'health') return sendJson(res, 200, { ok: true, time: new Date().toISOString() });

  // GET /api/dataset?group_id=DEV        — прямой прокси к API организаторов (без сохранения)
  // POST /api/dataset/sync?group_id=DEV  — скачать и сохранить в data/<group>_data.json
  if (parts[0] === 'dataset') {
    if (parts[1] === 'sync' && method === 'POST') {
      const { file, payload } = await syncDataset(groupId);
      datasets.set(groupId, payload);
      return sendJson(res, 200, {
        dataset_group_id: payload.dataset_group_id,
        total_records: payload.total_records,
        saved: payload.records.length,
        fetched_at: payload.fetched_at,
        file: file.replace(DATA_DIR, 'backend/data'),
      });
    }
    if (!parts[1] && method === 'GET') {
      const data = await fetchDataset(groupId);
      return sendJson(res, 200, { error: '', isSuccess: true, data });
    }
  }

  // GET /api/conversations?group_id=DEV       — список (без транскриптов)
  // GET /api/conversations/:id?group_id=DEV   — один диалог целиком
  if (parts[0] === 'conversations' && method === 'GET') {
    const ds = await getDataset(groupId);
    if (!parts[1]) {
      return sendJson(res, 200, {
        dataset_group_id: ds.dataset_group_id,
        fetched_at: ds.fetched_at,
        total_records: ds.total_records,
        records: ds.records.map((r) => ({
          conversation_id: r.conversation_id,
          channel: r.channel,
          language: r.language,
          has_audio: Boolean(r.audio_url),
          messages: r.transcript.length,
          preview: (r.transcript.find((t) => t.speaker === 'client') || {}).text || '',
        })),
      });
    }
    const rec = ds.records.find((r) => r.conversation_id === parts[1]);
    if (!rec) throw httpError(404, `Диалог ${parts[1]} не найден в наборе ${groupId}`);
    return sendJson(res, 200, rec);
  }

  // GET /api/audio/:conversation_id?group_id=DEV — редирект на mp3 записи звонка
  if (parts[0] === 'audio' && parts[1] && method === 'GET') {
    const ds = await getDataset(groupId);
    const rec = ds.records.find((r) => r.conversation_id === parts[1]);
    if (!rec?.audio_url) throw httpError(404, 'У этого диалога нет записи');
    let cached = audioCache.get(rec.conversation_id);
    if (!cached || cached.expires < Date.now()) {
      cached = { url: await resolveAudioUrl(rec.audio_url), expires: Date.now() + 45 * 60 * 1000 };
      audioCache.set(rec.conversation_id, cached);
    }
    res.writeHead(302, { location: cached.url, 'cache-control': 'no-store' });
    return res.end();
  }

  // /api/store/:collection[/:id] — простое JSON-хранилище
  //   GET    /api/store/checklists        — все документы
  //   GET    /api/store/checklists/:id    — один документ
  //   PUT    /api/store/checklists/:id    — создать/заменить
  //   DELETE /api/store/checklists/:id    — удалить
  if (parts[0] === 'store' && COLLECTIONS.has(parts[1])) {
    const name = parts[1];
    const id = parts[2];
    if (id && !ID_RE.test(id)) throw httpError(400, 'Некорректный id');
    const docs = await readCollection(name);

    if (method === 'GET' && !id) return sendJson(res, 200, Object.values(docs));
    if (method === 'GET') {
      if (!docs[id]) throw httpError(404, 'Документ не найден');
      return sendJson(res, 200, docs[id]);
    }
    if (method === 'PUT' && id) {
      const body = await readJsonBody(req);
      if (typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Ожидается JSON-объект');
      const now = new Date().toISOString();
      docs[id] = { ...body, id, created_at: docs[id]?.created_at || body.created_at || now, updated_at: now };
      await writeCollection(name, docs);
      return sendJson(res, 200, docs[id]);
    }
    if (method === 'DELETE' && id) {
      delete docs[id];
      await writeCollection(name, docs);
      return sendJson(res, 200, { deleted: id });
    }
  }

  // POST /api/evaluate  { group_id, conversation_id, checklist_id }
  // Оценивает диалог через LLM по сохранённому чек-листу и сохраняет результат в коллекцию evaluations.
  if (parts[0] === 'evaluate' && method === 'POST') {
    const body = await readJsonBody(req);
    const g = assertGroupId(body.group_id || groupId);
    const convId = String(body.conversation_id || '');
    const ds = await getDataset(g);
    const record = ds.records.find((r) => r.conversation_id === convId);
    if (!record) throw httpError(404, `Диалог ${convId} не найден в наборе ${g}`);
    const checklist = await loadChecklist(body.checklist_id);

    const key = `${g}__${convId}__${checklist.id}`;
    if (!evaluationsInFlight.has(key)) {
      evaluationsInFlight.set(
        key,
        (async () => {
          const ev = await evaluateConversation(record, checklist);
          const doc = toEvaluationDoc(ev, g);
          const docs = await readCollection('evaluations');
          const now = new Date().toISOString();
          docs[doc.id] = { ...doc, created_at: now, updated_at: now };
          await writeCollection('evaluations', docs);
          console.log(`[evaluate] ${key}: ${ev.итог.итоговый_балл} баллов, $${ev.стоимость.usd.toFixed(4)}, ${ev.время_сек} с`);
          return docs[doc.id];
        })().finally(() => evaluationsInFlight.delete(key))
      );
    }
    try {
      return sendJson(res, 200, await evaluationsInFlight.get(key));
    } catch (err) {
      // Код ошибки передаётся фронтенду, чтобы показать понятное сообщение:
      // INVALID_JSON / RULES_VIOLATION / REFUSAL / MAX_TOKENS (evaluator.js) или API_<статус> (Anthropic API).
      const code =
        err.code ||
        (err.status ? `API_${err.status}` : /timeout/i.test(err.name) ? 'API_TIMEOUT' : /connection/i.test(err.name) ? 'API_CONNECTION' : 'EVALUATION_FAILED');
      console.error(`[evaluate] ${key}: ${code} — ${err.message}`);
      throw Object.assign(httpError(502, `Оценка не выполнена: ${err.message}`), { code });
    }
  }

  throw httpError(404, `Неизвестный маршрут: ${method} ${url.pathname}`);
}

// ---------- статика фронтенда ----------

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(FRONTEND_DIR, rel));
  if (!file.startsWith(FRONTEND_DIR + sep)) throw httpError(403, 'Доступ запрещён');
  let info;
  try {
    info = await stat(file);
  } catch {
    throw httpError(404, 'Файл не найден');
  }
  if (!info.isFile()) throw httpError(404, 'Файл не найден');
  res.writeHead(200, {
    'content-type': MIME[extname(file)] || 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-cache',
  });
  createReadStream(file).pipe(res);
}

// ---------- сервер ----------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
  if (isApi) {
    // Разрешаем вызовы с других источников (например, веб-ресурс Dynamics 365 или file://).
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
  }
  try {
    if (isApi) await handleApi(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') await serveStatic(req, res, url);
    else throw httpError(405, 'Метод не поддерживается');
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(`[${req.method} ${url.pathname}]`, err);
    if (!res.headersSent) sendJson(res, status, { error: err.message, code: err.code || null, isSuccess: false });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`CQA сервер запущен: http://localhost:${PORT}`);
  console.log(`  API:      http://localhost:${PORT}/api/health`);
  console.log(`  Данные:   ${DATA_DIR}`);
});
