#!/usr/bin/env node
// Формирует файл для сдачи результатов в формате JSON 1.0
// (CQA_Student_Guide_Appendix_Results): results/dev/results.json или results/prod/results.json.
//
//   node generate_results.js                       DEV: data/dev_data.json → results/dev/results.json
//   node generate_results.js --prod                PROD: data/prod_data.json → results/prod/results.json
//   node generate_results.js --prod --group=CTRL   PROD из data/ctrl_data.json (после npm run fetch -- CTRL)
//   node generate_results.js --input=path.json     произвольный файл набора
//
// Параметры:
//   --team="Название"   team_name (иначе CQA_TEAM_NAME из .env, иначе «801»)
//   --delay=1500        пауза между запросами к API, мс (защита от 429)
//   --limit=5           оценить только первые N диалогов (проверка перед полным прогоном)
//   --fresh             не использовать сохранённый прогресс, оценить всё заново
//   --to-ui             также записать оценки в интерфейс (дашборд, карточки диалогов)
//   --dry-run           без вызовов модели: проверить набор и показать, что будет сделано
//
// Прогресс сохраняется после каждого диалога в data/eval_results/progress_<набор>.json:
// если прогон прервался, повторный запуск продолжит с места остановки и не оплатит
// уже оценённые диалоги (при том же чек-листе). Ошибочные диалоги оцениваются повторно.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { DATA_DIR, RESULTS_DIR, STORE_DIR } from './config.js';
import {
  EFFORT,
  MODEL,
  MODEL_MODE,
  TEAM_NAME,
  buildResultsFile,
  errorResult,
  evaluateConversation,
  loadChecklist,
  toEvaluationDoc,
  validateResultRecord,
} from './evaluator.js';

/* ---------- параметры ---------- */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : true];
  })
);
const SET = args.prod ? 'prod' : 'dev';
const DELAY_MS = Number(args.delay ?? 1500);
const LIMIT = args.limit ? Number(args.limit) : null;
const TEAM = typeof args.team === 'string' && args.team.trim() ? args.team.trim() : TEAM_NAME;
const EXPECTED = { dev: 65, prod: 10 }; // требования приложения: DEV — 60 чатов и 5 звонков, PROD — ровно 10 записей

// Повтор при перегрузке API, таймаутах и обрыве связи (SDK уже повторяет 2 раза сам).
const RETRYABLE = /^(API_429|API_5\d\d|API_TIMEOUT|API_CONNECTION)$/;
const RETRY_WAIT_MS = [20_000, 60_000];

const inputFile = typeof args.input === 'string'
  ? resolve(args.input)
  : join(DATA_DIR, `${(typeof args.group === 'string' ? args.group : SET).toLowerCase()}_data.json`);
const outDir = join(RESULTS_DIR, SET);
const outFile = join(outDir, 'results.json');
const progressFile = join(DATA_DIR, 'eval_results', `progress_${SET}.json`);

/* ---------- оформление ---------- */

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const green = paint('32');
const red = paint('31');
const yellow = paint('33');
const gray = paint('90');
const bold = paint('1');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rel = (p) => relative(process.cwd(), p) || p;
const fmtDuration = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return s >= 60 ? `${Math.floor(s / 60)} мин ${String(s % 60).padStart(2, '0')} с` : `${s} с`;
};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw err;
  }
}

/** Запись через временный файл: при сбое на середине записи старый файл не повреждается. */
async function writeJsonAtomic(file, data, space) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, space), 'utf8');
  await rename(tmp, file);
}

/* ---------- подготовка ---------- */

let dataset;
try {
  dataset = await readJson(inputFile);
} catch (err) {
  console.error(red(`✗ Не удалось прочитать набор ${rel(inputFile)}: ${err.message}`));
  console.error(gray(`  Скачайте его: npm run fetch -- <group_id>${SET === 'prod' ? '  и запустите с --prod --group=<group_id>' : ''}`));
  process.exit(1);
}
const allRecords = Array.isArray(dataset.records) ? dataset.records : [];
const ids = allRecords.map((r) => r.conversation_id);
const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
if (!allRecords.length || dupIds.length) {
  console.error(red(`✗ Набор некорректен: записей ${allRecords.length}${dupIds.length ? `, повторяются ID: ${[...new Set(dupIds)].join(', ')}` : ''}`));
  process.exit(1);
}
const records = LIMIT ? allRecords.slice(0, LIMIT) : allRecords;

const checklist = await loadChecklist();
// Отпечаток чек-листа: сохранённый прогресс переиспользуется, только если правила не менялись.
const checklistHash = createHash('sha256')
  .update(JSON.stringify({ criteria: checklist.criteria, sections: checklist.sections, model: MODEL, effort: EFFORT }))
  .digest('hex')
  .slice(0, 16);

const STANDARD_IDS = ['contact', 'discovery', 'identification', 'consultation', 'empathy', 'dialogue', 'closure', 'critical'];
const criterionIds = checklist.criteria.map((c) => c.id);
const nonStandard = criterionIds.join(',') !== STANDARD_IDS.join(',');

let progress = args.fresh ? {} : await readJson(progressFile, {});
if (progress.checklist_hash && progress.checklist_hash !== checklistHash) {
  console.log(yellow('⚠ Чек-лист или модель изменились с прошлого прогона — сохранённый прогресс не используется.'));
  progress = {};
}
progress.checklist_hash = checklistHash;
progress.items = progress.items || {};
const cachedOk = records.filter((r) => progress.items[r.conversation_id]?.result?.status === 'ok').length;

console.log();
console.log(bold(`CQA · формирование results/${SET}/results.json (JSON 1.0)`));
console.log(gray('─'.repeat(78)));
console.log(`Набор:     ${rel(inputFile)} · ${allRecords.length} диалогов${LIMIT ? ` (оцениваются первые ${records.length})` : ''}`);
console.log(`Чек-лист:  «${checklist.name}» v${checklist.version} · ${criterionIds.join(', ')}`);
console.log(`Модель:    ${MODEL} (${MODEL_MODE}) · effort ${EFFORT} · пауза между запросами ${DELAY_MS} мс`);
console.log(`Команда:   ${TEAM}`);
console.log(`Результат: ${rel(outFile)}`);
if (cachedOk) console.log(green(`Прогресс:  ${cachedOk} диалогов уже оценены — будут взяты из ${rel(progressFile)}`));
if (nonStandard) console.log(yellow(`⚠ Коды критериев отличаются от приложения (${STANDARD_IDS.join(', ')}) — проверьте чек-лист.`));
if (allRecords.length !== EXPECTED[SET]) {
  console.log(yellow(`⚠ В наборе ${allRecords.length} записей, по приложению для ${SET.toUpperCase()} ожидается ${EXPECTED[SET]}.`));
}
console.log(gray('─'.repeat(78)));

if (args['dry-run']) {
  const toEvaluate = records.length - cachedOk;
  console.log(`Будет оценено диалогов: ${toEvaluate} · примерная стоимость ≈ $${(toEvaluate * 0.06).toFixed(2)} · время ≈ ${fmtDuration(toEvaluate * (22 + DELAY_MS / 1000))}`);
  console.log(gray('--dry-run: модель не вызывалась, файлы не изменены.'));
  process.exit(0);
}

await mkdir(join(RESULTS_DIR, 'dev'), { recursive: true });
await mkdir(join(RESULTS_DIR, 'prod'), { recursive: true });
await mkdir(join(DATA_DIR, 'eval_results'), { recursive: true });

/* ---------- оценка ---------- */

const started = Date.now();
let evaluatedNow = 0;
let spent = 0;
let lastCallAt = 0;

for (const [i, rec] of records.entries()) {
  const n = i + 1;
  const head = `${gray(`[${String(n).padStart(String(records.length).length)}/${records.length}]`)} ${rec.conversation_id.padEnd(10)}`;
  const cached = progress.items[rec.conversation_id];
  if (cached?.result?.status === 'ok') {
    console.log(`${head} ${green('✓')} ${String(cached.result.score.final_score ?? '—').padStart(6)}  ${gray('из сохранённого прогресса')}`);
    continue;
  }

  let ev;
  for (let attempt = 0; ; attempt++) {
    // Пауза между запросами к API — защита от ошибки 429.
    const wait = lastCallAt + DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();

    if (!Array.isArray(rec.transcript) || !rec.transcript.length) {
      ev = { result: errorResult(rec.conversation_id, new Error('В наборе нет транскрипта для этого диалога')), meta: { error_code: 'NO_TRANSCRIPT', cost: null } };
      break;
    }
    ev = await evaluateConversation(rec, checklist); // не бросает: при сбое status = "error"
    if (ev.meta.cost) spent += ev.meta.cost.usd;
    const code = ev.meta.error_code;
    if (ev.result.status === 'ok' || !RETRYABLE.test(code || '') || attempt >= RETRY_WAIT_MS.length) break;
    console.log(`${head} ${yellow(`⚠ ${code} — повтор через ${RETRY_WAIT_MS[attempt] / 1000} с`)}`);
    await sleep(RETRY_WAIT_MS[attempt]);
  }
  evaluatedNow++;

  progress.items[rec.conversation_id] = { result: ev.result, meta: ev.meta, evaluated_at: new Date().toISOString() };
  await writeJsonAtomic(progressFile, progress, 0);

  const elapsed = (Date.now() - started) / 1000;
  const remaining = records.slice(i + 1).filter((r) => progress.items[r.conversation_id]?.result?.status !== 'ok').length;
  const eta = remaining ? ` · осталось ≈ ${fmtDuration((elapsed / evaluatedNow) * remaining)}` : '';
  const tail = ev.result.status === 'ok'
    ? `${green('✓')} ${String(ev.result.score.final_score ?? '—').padStart(6)}${ev.result.score.critical_flag ? red('  грубая ошибка') : ''}  ${gray(`${ev.meta.seconds} с · $${ev.meta.cost.usd.toFixed(4)}`)}`
    : `${red('✗ status "error"')}  ${gray(`${ev.meta.error_code}: ${ev.result.error.slice(0, 70)}`)}`;
  console.log(`${head} ${tail}`);
  console.log(gray(`      Обработан диалог ${n} из ${records.length}${eta} · потрачено $${spent.toFixed(2)}`));
}

/* ---------- сборка и проверка файла ---------- */

// Порядок — как в наборе; для каждого диалога ровно одна запись (ошибка не скрывается и не заменяется нулём).
const results = records.map((r) => progress.items[r.conversation_id]?.result || errorResult(r.conversation_id, new Error('Диалог не был оценён')));
const usedModels = [...new Set(records.map((r) => progress.items[r.conversation_id]?.meta?.model).filter(Boolean))];
const file = buildResultsFile(results, { teamName: TEAM, modelName: (usedModels.length ? usedModels : [MODEL]).join(', ') });

const transcriptLength = Object.fromEntries(records.map((r) => [r.conversation_id, (r.transcript || []).length]));
const problems = [];
results.forEach((r) => {
  for (const e of validateResultRecord(r, checklist, transcriptLength[r.conversation_id])) problems.push(`${r.conversation_id}: ${e}`);
});
const outIds = results.map((r) => r.conversation_id);
if (new Set(outIds).size !== outIds.length) problems.push('повторяющиеся conversation_id');
const missing = records.filter((r) => !outIds.includes(r.conversation_id)).map((r) => r.conversation_id);
if (missing.length) problems.push(`нет записей для: ${missing.join(', ')}`);

// Компактный JSON в UTF-8: без отступов и лишних пробелов.
await writeJsonAtomic(outFile, file);
// Проверка, что файл читается обратно и совпадает с тем, что собрали.
const reread = JSON.parse(await readFile(outFile, 'utf8'));
if (JSON.stringify(reread) !== JSON.stringify(file)) problems.push('файл после записи не совпадает с собранными данными');

/* ---------- запись в интерфейс (по флагу) ---------- */

if (args['to-ui']) {
  const groupId = String(dataset.dataset_group_id || (typeof args.group === 'string' ? args.group : SET)).toUpperCase();
  const storeFile = join(STORE_DIR, 'evaluations.json');
  await mkdir(STORE_DIR, { recursive: true });
  const docs = await readJson(storeFile, {});
  const now = new Date().toISOString();
  let written = 0;
  for (const r of records) {
    const item = progress.items[r.conversation_id];
    if (item?.result?.status !== 'ok') continue;
    const doc = toEvaluationDoc(item, groupId);
    docs[doc.id] = { ...doc, created_at: docs[doc.id]?.created_at || now, updated_at: now };
    written++;
  }
  await writeJsonAtomic(storeFile, docs, 2);
  console.log(green(`✓ В интерфейс записано оценок: ${written} (набор ${groupId}) — обновите страницу`));
}

/* ---------- итог ---------- */

const ok = results.filter((r) => r.status === 'ok');
const errors = results.filter((r) => r.status === 'error');
const scores = ok.map((r) => r.score.final_score).filter((s) => typeof s === 'number');
const avg = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2) : '—';
const totalCost = records.reduce((s, r) => s + (progress.items[r.conversation_id]?.meta?.cost?.usd || 0), 0);

console.log(gray('─'.repeat(78)));
console.log(`Записей: ${results.length} · ${green(`ok ${ok.length}`)} · ${errors.length ? red(`error ${errors.length}`) : 'error 0'} · средний final_score ${avg} · грубых ошибок ${ok.filter((r) => r.score.critical_flag).length}`);
console.log(`Стоимость: $${totalCost.toFixed(2)} всего (в этом запуске $${spent.toFixed(2)}) · время ${fmtDuration((Date.now() - started) / 1000)}`);
for (const r of errors) console.log(red(`  ✗ ${r.conversation_id}: ${r.error}`));
if (problems.length) {
  console.log(red(bold(`✗ Файл не прошёл проверку формата (${problems.length}):`)));
  for (const p of problems.slice(0, 20)) console.log(red(`  · ${p}`));
} else {
  console.log(green(bold(`✓ ${rel(outFile)} — формат JSON 1.0 проверен, ${results.length} записей, ID уникальны`)));
}
if (errors.length) console.log(yellow('  Повторный запуск дооценит только диалоги со status "error".'));
console.log(gray(`  Не забудьте: git add ${rel(outFile)} && git commit && git push — до стоп-кода.`));
console.log();
process.exit(problems.length ? 1 : 0);
