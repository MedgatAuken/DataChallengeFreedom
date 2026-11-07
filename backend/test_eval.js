#!/usr/bin/env node
// Тест модуля оценки на одном диалоге из локального набора.
//
//   node test_eval.js                 -> p1-ru-001 из data/dev_data.json
//   node test_eval.js p2-kz-003       -> другой диалог
//   node test_eval.js p1-ru-001 --json -> только итоговый JSON
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';
import { EFFORT, MODEL, evaluateConversation, loadChecklist } from './evaluator.js';

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

let ev;
try {
  ev = await evaluateConversation(record, checklist);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}

// Сохраняем полный результат, чтобы его можно было посмотреть и переиспользовать.
const outDir = join(DATA_DIR, 'eval_results');
await mkdir(outDir, { recursive: true });
const outFile = join(outDir, `${record.conversation_id}.json`);
await writeFile(outFile, JSON.stringify(ev, null, 2), 'utf8');

if (jsonOnly) {
  console.log(JSON.stringify(ev, null, 2));
  process.exit(0);
}

const { итог, стоимость } = ev;
const fmtAnswer = (r) => (r.оценка === undefined ? '—' : String(r.оценка));

console.log('КРИТЕРИИ');
for (const r of итог.критерии) {
  const pts =
    r.статус === 'применим' ? `${r.баллы} из ${r.эффективный_вес} (вес ${r.исходный_вес})`
    : r.статус === 'N/A' ? `исключён, вес ${r.исходный_вес} перераспределён`
    : 'без баллов';
  console.log(`\n  ${r.id} ${r.критерий}: ${fmtAnswer(r)}  →  ${pts}`);
  console.log(`     Обоснование: ${r.обоснование}`);
  if (r.реплика_доказательство) console.log(`     Доказательство [#${r.номера_реплик.join(', #')}]: «${r.реплика_доказательство}»`);
  if (r.проверенный_участок.length) console.log(`     Проверенный участок: #${r.проверенный_участок.join('–#')}`);
}

console.log('\nСЕКЦИИ');
for (const s of итог.секции) console.log(`  ${s.секция}: ${s.баллы} / ${s.максимум}`);

console.log('\nИТОГ');
console.log(`  Итоговый балл: ${итог.итоговый_балл ?? 'не рассчитывается'} / ${итог.максимум}`);
console.log(`  N/A: ${итог.na_критерии.join(', ') || 'нет'}  (сумма применимых весов ${итог.сумма_применимых_весов})`);
console.log(`  Грубая ошибка: ${итог.грубая_ошибка ? 'ДА — ' + итог.грубые_ошибки.map((g) => g.обоснование).join('; ') : 'нет'}`);
console.log(`  Резюме: ${ev.оценка_llm.резюме}`);

console.log('\nСТОИМОСТЬ');
console.log(`  Модель: ${стоимость.модель}, вызовов: ${стоимость.вызовов}, время: ${ev.время_сек} с`);
console.log(`  Токены: вход ${стоимость.input_tokens}, выход ${стоимость.output_tokens} (включая размышления), кэш: запись ${стоимость.cache_write_tokens} / чтение ${стоимость.cache_read_tokens}`);
console.log(`  Стоимость оценки: $${стоимость.usd.toFixed(4)}`);
console.log(`\n✓ Полный результат: ${outFile}`);
