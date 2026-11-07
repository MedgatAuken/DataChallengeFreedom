#!/usr/bin/env node
// Скачивает набор диалогов из API организаторов и сохраняет его локально.
//
//   node fetch_dataset.js            -> group_id=DEV  -> data/dev_data.json
//   node fetch_dataset.js CONTROL    -> group_id=CONTROL -> data/control_data.json
//
// Модуль также используется сервером (POST /api/dataset/sync).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA_DIR, DEFAULT_GROUP_ID, ORGANIZER_API_URL } from './config.js';

const GROUP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function assertGroupId(groupId) {
  if (!GROUP_ID_RE.test(String(groupId || ''))) {
    throw Object.assign(new Error(`Некорректный group_id: "${groupId}"`), { status: 400 });
  }
  return groupId;
}

export function buildOrganizerUrl(groupId) {
  if (!ORGANIZER_API_URL) {
    throw Object.assign(
      new Error('Не задан адрес API организаторов: скопируйте backend/.env.example в backend/.env и укажите CQA_API_URL'),
      { status: 500 }
    );
  }
  const url = new URL(ORGANIZER_API_URL);
  url.searchParams.set('group_id', assertGroupId(groupId));
  return url;
}

export function datasetPath(groupId) {
  return join(DATA_DIR, `${assertGroupId(groupId).toLowerCase()}_data.json`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET к API организаторов. Возвращает объект `data` из ответа ({dataset_group_id, total_records, records}). */
export async function fetchDataset(groupId = DEFAULT_GROUP_ID, { retries = 3, timeoutMs = 90_000 } = {}) {
  const url = buildOrganizerUrl(groupId);
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`API ответил HTTP ${res.status} ${res.statusText}`);
      const body = await res.json();
      if (!body.isSuccess) throw new Error(`API вернул isSuccess=false: ${body.error || 'без описания'}`);
      const data = body.data || {};
      if (!Array.isArray(data.records)) throw new Error('В ответе нет массива data.records');
      return data;
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  throw Object.assign(new Error(`Не удалось получить набор ${groupId}: ${lastError.message}`), { status: 502 });
}

/** Скачивает набор и сохраняет в data/<group>_data.json. Исходные метки времени не изменяются. */
export async function syncDataset(groupId = DEFAULT_GROUP_ID) {
  const data = await fetchDataset(groupId);
  const payload = {
    dataset_group_id: data.dataset_group_id ?? groupId,
    total_records: data.total_records ?? data.records.length,
    fetched_at: new Date().toISOString(),
    records: data.records,
  };
  const file = datasetPath(groupId);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
  return { file, payload };
}

/** Читает ранее сохранённый набор. Возвращает null, если файла ещё нет. */
export async function loadDataset(groupId = DEFAULT_GROUP_ID) {
  try {
    return JSON.parse(await readFile(datasetPath(groupId), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function summarize(records) {
  const by = (key) =>
    records.reduce((acc, r) => ((acc[r[key]] = (acc[r[key]] || 0) + 1), acc), {});
  return { channel: by('channel'), language: by('language') };
}

// Запуск из командной строки
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const groupId = process.argv[2] || DEFAULT_GROUP_ID;
  try {
    console.log(`→ GET group_id=${groupId} ...`);
    const { file, payload } = await syncDataset(groupId);
    const n = payload.records.length;
    console.log(`✓ Получено диалогов: ${n} (total_records=${payload.total_records})`);
    if (n !== payload.total_records) console.warn('! Количество записей не совпадает с total_records');
    console.log('  ', JSON.stringify(summarize(payload.records)));
    console.log(`✓ Сохранено: ${file}`);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
}
