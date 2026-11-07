#!/usr/bin/env node
// Тест модуля оценки на одном диалоге из локального набора. Результат — запись в формате JSON 1.0.
//
//   node test_eval.js                  -> p1-ru-001 из data/dev_data.json
//   node test_eval.js p1-kz-001        -> другой диалог
//   node test_eval.js p1-ru-001 --json -> только запись JSON 1.0
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';
import { EFFORT, MODEL, evaluateConversation, loadChecklist, validateResultRecord } from './evaluator.js';

const args = process.argv.slice(2);
const jsonOnly = args.includes('--json');
const conversationId = args.find((a) => !a.startsWith('--')) || 'p1-ru-001';

const datasetFile = join(DATA_DIR, 'dev_data.json');
let dataset;
try {
  dataset = JSON.parse(await readFile(datasetFile, 'utf8'));
} catch (err) {
  console.error(`✗ Не удалось прочитать ${datasetFile}: ${err.message}\n  Сначала выполните: npm run fetch`);
  process.exit(1);
}

const record = dataset.records.find((r) => r.conversation_id === conversationId);
if (!record) {
  console.error(`✗ Диалог ${conversationId} не найден в dev_data.json`);
  process.exit(1);
}

const checklist = await loadChecklist();
if (!jsonOnly) {
  console.log(`→ Диалог ${record.conversation_id} (${record.channel}, ${record.language}, ${record.transcript.length} реплик)`);
  console.log(`→ Чек-лист «${checklist.name}» v${checklist.version}, модель ${MODEL}, effort ${EFFORT}`);
  console.log('→ Отправляю в LLM…\n');
}

// evaluateConversation не бросает исключений: при сбое result.status = "error".
const { result, meta } = await evaluateConversation(record, checklist);

// Сохраняем запись и служебные данные, чтобы их можно было посмотреть и переиспользовать.
const outDir = join(DATA_DIR, 'eval_results');
await mkdir(outDir, { recursive: true });
const outFile = join(outDir, `${record.conversation_id}.json`);
await writeFile(outFile, JSON.stringify({ result, meta }, null, 2), 'utf8');

const formatErrors = validateResultRecord(result, checklist, record.transcript.length);

if (jsonOnly) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'ok' && !formatErrors.length ? 0 : 1);
}

if (result.status === 'error') {
  console.log('ЗАПИСЬ JSON 1.0 (ошибка)');
  console.log(JSON.stringify(result, null, 2));
  console.log(`\n✗ Оценка не выполнена: ${meta.error_code} — ${meta.error_detail}`);
  process.exit(1);
}

const fmtValue = (v) => (v === null ? 'null (N/A)' : JSON.stringify(v));
const rows = Object.fromEntries(meta.breakdown.rows.map((r) => [r.criterion_id, r]));

console.log('КРИТЕРИИ');
for (const x of result.criteria) {
  const r = rows[x.criterion_id];
  const pts =
    r.status === 'scored' ? `${r.points} из ${r.effective_weight} (вес ${r.weight})`
    : r.status === 'na' ? `исключён, вес ${r.weight} перераспределён`
    : 'без баллов';
  const note = meta.notes[x.criterion_id] || {};
  console.log(`\n  ${x.criterion_id} · ${r.title}: ${fmtValue(x.value)}  →  ${pts}`);
  console.log(`     rationale: ${x.rationale}`);
  console.log(`     evidence_turns: [${x.evidence_turns.join(', ')}]${note.quote ? `  «${note.quote}»` : ''}`);
  if (note.checked_turns && note.checked_turns.length) console.log(`     Проверенный участок: #${note.checked_turns.join('–#')}`);
}

console.log('\nСЕКЦИИ');
for (const s of meta.breakdown.sections) console.log(`  ${s.title}: ${s.points} / ${s.max}`);

console.log('\nSCORE');
console.log(`  final_score: ${result.score.final_score ?? 'null (нет применимых критериев)'}`);
console.log(`  critical_flag: ${result.score.critical_flag}`);
console.log(`  N/A: ${meta.breakdown.na.join(', ') || 'нет'}  (сумма применимых весов ${meta.breakdown.applicable_weight})`);
console.log(`  summary: ${meta.summary}`);

console.log('\nФОРМАТ JSON 1.0');
console.log(formatErrors.length ? `  ✗ ${formatErrors.join('\n  ✗ ')}` : '  ✓ запись соответствует формату');

const cost = meta.cost;
console.log('\nСТОИМОСТЬ');
console.log(`  Модель: ${cost.model}, вызовов: ${cost.calls}, время: ${meta.seconds} с`);
console.log(`  Токены: вход ${cost.input_tokens}, выход ${cost.output_tokens} (включая размышления), кэш: запись ${cost.cache_write_tokens} / чтение ${cost.cache_read_tokens}`);
console.log(`  Стоимость оценки: $${cost.usd.toFixed(4)}`);
console.log(`\n✓ Полный результат: ${outFile}`);
