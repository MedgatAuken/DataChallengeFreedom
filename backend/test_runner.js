#!/usr/bin/env node
// Проверка стабильности модуля оценки на реальных диалогах DEV (формат результата — JSON 1.0).
//
// Берёт по 3 диалога на каждый язык (RU, KZ, EN; в RU — один звонок), по очереди отправляет их
// в evaluator.js и проверяет:
//   1. ответ модели разбирается как JSON и соответствует правилам чек-листа (ошибки — по кодам);
//   2. пересчёт итога (N/A, перераспределение весов, грубые ошибки) не падает и даёт корректные числа,
//      совпадающие с алгоритмом фронтенда, в том числе на стресс-вариантах с N/A;
//   3. печатает отчёт и сохраняет его в data/eval_results/test_runner_<время>.json.
//
//   node test_runner.js                      9 диалогов: первые по каждому языку
//   node test_runner.js --random             случайная выборка
//   node test_runner.js --per-lang=1         по 1 диалогу на язык
//   node test_runner.js --ids=p1-ru-001,p1-kz-002
//
// Каждая оценка — платный вызов LLM (~$0.05). Код возврата: 0 — всё успешно, 1 — есть ошибки.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { DATA_DIR } from './config.js';
import { EFFORT, MODEL, computeFinalScore, evaluateConversation, loadChecklist, validateResultRecord } from './evaluator.js';

// Алгоритм расчёта фронтенда (frontend/app.js) — для сверки с бэкендом.
const require = createRequire(import.meta.url);
require('../frontend/app.js');
const frontend = globalThis.CQA;

/* ---------- параметры ---------- */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const PER_LANG = Number(args['per-lang'] || 3);
const LANGS = ['RU', 'KZ', 'EN'];

/* ---------- оформление ---------- */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR && !args['no-color'];
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { green: paint('32'), red: paint('31'), yellow: paint('33'), gray: paint('90'), bold: paint('1'), cyan: paint('36') };
const OK = c.green('✓');
const FAIL = c.red('✗');
const WARN = c.yellow('⚠');
const line = (ch = '─') => c.gray(ch.repeat(78));
const fmtTime = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)} мин ${String(Math.round(sec % 60)).padStart(2, '0')} с` : `${sec.toFixed(1)} с`);
const approx = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;

/* ---------- выбор диалогов ---------- */

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickRecords(records) {
  if (args.ids) {
    const ids = String(args.ids).split(',').map((s) => s.trim());
    const missing = ids.filter((id) => !records.some((r) => r.conversation_id === id));
    if (missing.length) throw new Error(`Нет в dev_data.json: ${missing.join(', ')}`);
    return ids.map((id) => records.find((r) => r.conversation_id === id));
  }
  const picked = [];
  for (const lang of LANGS) {
    const pool = records.filter((r) => r.language === lang);
    const ordered = args.random ? shuffle(pool) : pool;
    const chosen = [];
    // В RU-наборе есть звонки (ISO-время, другой формат) — берём хотя бы один, если он есть.
    const call = ordered.find((r) => r.channel === 'voice call');
    if (call && PER_LANG > 1) chosen.push(call);
    for (const r of ordered) {
      if (chosen.length >= PER_LANG) break;
      if (!chosen.includes(r) && r.channel !== 'voice call') chosen.push(r);
    }
    picked.push(...chosen.sort((a, b) => a.conversation_id.localeCompare(b.conversation_id)));
  }
  return picked;
}

/* ---------- проверки расчёта ---------- */

// JSON 1.0: null = N/A; во фронтенде N/A обозначается 'NA'.
const toFrontendValue = (v) => (v === null ? 'NA' : v);

function frontendTotal(criteria, checklist) {
  const answers = {};
  for (const x of criteria) answers[x.criterion_id] = { value: toFrontendValue(x.value) };
  return frontend.computeScore(checklist, answers).total;
}

/** Инварианты итога по правилам чек-листа. Возвращает список проверок { name, ok, detail }. */
function checkScore(score, checklist, label) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name: `${label}${name}`, ok: Boolean(ok), detail });
  const scored = score.rows.filter((r) => r.status === 'scored');
  const na = score.rows.filter((r) => r.status === 'na');

  if (score.applicable_weight > 0) {
    add('итог в диапазоне 0–100', score.final_score >= 0 && score.final_score <= 100, `итог ${score.final_score}`);
    const effSum = scored.reduce((s, r) => s + r.effective_weight, 0);
    add('веса после N/A дают 100', approx(effSum, 100), `сумма ${effSum.toFixed(2)}`);
    const ptsSum = scored.reduce((s, r) => s + r.points, 0);
    add('сумма баллов = итог', approx(ptsSum, score.final_score), `${ptsSum.toFixed(2)} vs ${score.final_score}`);
    add('итог округлён до 2 знаков', Number.isInteger(Math.round(score.final_score * 100 * 1e6) / 1e6), String(score.final_score));
  } else {
    add('без применимых весов итог = null', score.final_score === null, `итог ${score.final_score}`);
  }
  add('N/A не получают баллов', na.every((r) => r.points === null && r.effective_weight === 0), na.map((r) => r.criterion_id).join(', ') || 'нет N/A');

  const critRows = score.rows.filter((r) => r.status === 'critical');
  const critYes = critRows.some((r) => r.value === true);
  add('critical_flag = value критерия critical, без баллов', score.critical_flag === critYes && critRows.every((r) => r.points === null), `флаг ${score.critical_flag}`);

  const appliedWeight = checklist.criteria
    .filter((cr) => cr.type !== 'critical' && cr.weight > 0 && !na.some((r) => r.criterion_id === cr.id))
    .reduce((s, cr) => s + cr.weight, 0);
  add('применимый вес посчитан верно', score.applicable_weight === appliedWeight, `${score.applicable_weight} vs ${appliedWeight}`);
  return checks;
}

/** Проверки записи JSON 1.0 и расчёта итога на реальном ответе модели и стресс-вариантах. */
function scoringChecks(ev, checklist, transcriptLength) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });
  const { result } = ev;

  // Формат JSON 1.0: поля, коды критериев, типы value, номера реплик с 1.
  const formatErrors = validateResultRecord(result, checklist, transcriptLength);
  add('формат JSON 1.0', !formatErrors.length, formatErrors.join('; '));
  add('evidence_turns: целые числа ≥ 1, по возрастанию',
    result.criteria.every((x) => x.evidence_turns.length && x.evidence_turns.every((n, i, a) => Number.isInteger(n) && n >= 1 && (i === 0 || a[i - 1] < n))),
    result.criteria.map((x) => `${x.criterion_id}:[${x.evidence_turns}]`).join(' '));

  // Пересчёт итога на реальном ответе модели.
  let recalculated;
  try {
    recalculated = computeFinalScore(result.criteria, checklist);
    add('пересчёт не падает', true);
  } catch (err) {
    add('пересчёт не падает', false, err.message);
    return checks;
  }
  add('score.final_score совпадает с пересчётом', recalculated.final_score === result.score.final_score, `${recalculated.final_score} vs ${result.score.final_score}`);
  checks.push(...checkScore(recalculated, checklist, ''));

  const fe = frontendTotal(result.criteria, checklist);
  add('фронтенд считает так же', fe === recalculated.final_score, `фронтенд ${fe}, бэкенд ${recalculated.final_score}`);

  // Стресс 1: все критерии, где N/A разрешён, переводим в null.
  const naAllowed = new Set(checklist.criteria.filter((cr) => cr.na_allowed && cr.type !== 'critical').map((cr) => cr.id));
  const allNA = result.criteria.map((x) => (naAllowed.has(x.criterion_id) ? { ...x, value: null } : x));
  try {
    const s = computeFinalScore(allNA, checklist);
    checks.push(...checkScore(s, checklist, 'стресс «все допустимые N/A»: '));
    add('стресс «все допустимые N/A»: фронтенд совпадает', frontendTotal(allNA, checklist) === s.final_score, String(s.final_score));
  } catch (err) {
    add('стресс «все допустимые N/A»: не падает', false, err.message);
  }

  // Стресс 2: ни одного применимого критерия с весом — итог не рассчитывается.
  const weighted = new Set(checklist.criteria.filter((cr) => cr.type !== 'critical' && cr.weight > 0).map((cr) => cr.id));
  const noneApplicable = result.criteria.map((x) => (weighted.has(x.criterion_id) ? { ...x, value: null } : x));
  try {
    const s = computeFinalScore(noneApplicable, checklist);
    add('стресс «всё N/A»: final_score = null', s.final_score === null, `итог ${s.final_score}`);
  } catch (err) {
    add('стресс «всё N/A»: не падает', false, err.message);
  }
  return checks;
}

function classify(err) {
  if (err && err.name === 'EvaluationError') return err.code;
  if (err instanceof Anthropic.APIError) return `API_${err.status ?? 'CONNECTION'}`;
  return 'EXCEPTION';
}

/* ---------- стиль обоснований ---------- */

// Эвристика: эмоциональная и оценочная лексика, запрещённая правилами стиля в промпте.
const EMOTIONAL = /(^|[^а-яё])(отличн|образцов|прекрасн|блестящ|великолепн|замечательн|к сожалению|увы|молод(ец|цом)|ужасн|безупречн|идеальн|грубо проигнорир)|!/i;

function styleIssues(ev) {
  const texts = [
    ...ev.result.criteria.map((x) => ({ where: x.criterion_id, text: x.rationale })),
    { where: 'summary', text: ev.meta.summary },
  ];
  return texts
    .filter((t) => EMOTIONAL.test(t.text || ''))
    .map((t) => ({ where: t.where, match: (t.text.match(EMOTIONAL) || [''])[0].trim(), text: t.text }));
}

const ERROR_HINT = {
  INVALID_JSON: 'модель вернула невалидный JSON (после повтора)',
  RULES_VIOLATION: 'ответ нарушает правила чек-листа или формата (после повтора)',
  REFUSAL: 'модель отказалась отвечать',
  MAX_TOKENS: 'ответ обрезан по max_tokens',
  NO_API_KEY: 'не задан ANTHROPIC_API_KEY',
  EXCEPTION: 'исключение в коде',
};

/* ---------- запуск ---------- */

const datasetFile = join(DATA_DIR, 'dev_data.json');
let dataset;
try {
  dataset = JSON.parse(await readFile(datasetFile, 'utf8'));
} catch (err) {
  console.error(`${FAIL} Не удалось прочитать ${datasetFile}: ${err.message}\n  Сначала выполните: npm run fetch`);
  process.exit(1);
}

let selected;
try {
  selected = pickRecords(dataset.records);
} catch (err) {
  console.error(`${FAIL} ${err.message}`);
  process.exit(1);
}
const checklist = await loadChecklist();

console.log();
console.log(c.bold('CQA · проверка стабильности модуля оценки'));
console.log(line('═'));
console.log(`Модель ${c.cyan(MODEL)} · effort ${EFFORT} · чек-лист «${checklist.name}» v${checklist.version} (${checklist.criteria.length} критериев)`);
const byLangCount = LANGS.map((l) => `${l} ×${selected.filter((r) => r.language === l).length}`).join(', ');
console.log(`Диалогов: ${selected.length} (${byLangCount}) · оцениваются по очереди`);
console.log(line());

const results = [];
const started = Date.now();

for (const [i, rec] of selected.entries()) {
  const tag = `[${i + 1}/${selected.length}]`;
  const head = `${c.gray(tag)} ${rec.conversation_id.padEnd(10)} ${rec.language}  ${(rec.channel === 'voice call' ? 'звонок' : 'чат').padEnd(6)} ${String(rec.transcript.length).padStart(3)} репл.`;
  process.stdout.write(`${head}  ${c.gray('оценка…')}`);

  const item = { conversation_id: rec.conversation_id, language: rec.language, channel: rec.channel, replies: rec.transcript.length };
  try {
    // evaluateConversation не бросает: при сбое возвращает запись status "error" по формату JSON 1.0.
    const ev = await evaluateConversation(rec, checklist);
    item.record = ev.result; // запись JSON 1.0 как есть
    if (ev.result.status === 'error') {
      const formatErrors = validateResultRecord(ev.result, checklist);
      Object.assign(item, {
        status: 'error',
        error_code: ev.meta.error_code,
        error: ev.meta.error_detail || ev.result.error,
        error_record_valid: !formatErrors.length,
        attempts: ev.meta.attempts,
        issues: ev.meta.issues,
        cost: ev.meta.cost,
      });
    } else {
      const checks = scoringChecks(ev, checklist, rec.transcript.length);
      const failed = checks.filter((x) => !x.ok);
      Object.assign(item, {
        status: failed.length ? 'scoring_failed' : ev.meta.attempts > 1 ? 'ok_after_retry' : 'ok',
        total: ev.result.score.final_score,
        na: ev.meta.breakdown.na,
        critical: ev.result.score.critical_flag,
        attempts: ev.meta.attempts,
        issues: ev.meta.issues,
        seconds: ev.meta.seconds,
        cost: ev.meta.cost,
        checks,
        style: styleIssues(ev),
        summary: ev.meta.summary,
      });
    }
  } catch (err) {
    // Сюда попадает только ошибка в самом коде проверок — evaluateConversation исключений не бросает.
    Object.assign(item, { status: 'error', error_code: classify(err), error: err.message });
  }
  results.push(item);

  // Перерисовываем строку с результатом.
  const mark = item.status === 'ok' ? OK : item.status === 'error' || item.status === 'scoring_failed' ? FAIL : WARN;
  let tail;
  if (item.status === 'error') {
    tail = `${c.red(item.error_code)} ${c.gray(item.error.split('\n')[0].slice(0, 60))}`;
  } else {
    const total = item.total == null ? '  —  ' : String(item.total).padStart(6);
    const na = item.na.length ? `N/A: ${item.na.join(',')}` : 'без N/A';
    tail = [
      c.bold(total),
      na.padEnd(16),
      item.critical ? c.red('грубая ошибка') : '',
      item.attempts > 1 ? c.yellow(`повтор ×${item.attempts - 1}`) : '',
      c.gray(`${item.seconds} с · $${item.cost.usd.toFixed(4)}`),
      item.status === 'scoring_failed' ? c.red(`проверки: ${item.checks.filter((x) => !x.ok).length} ✗`) : '',
    ].filter(Boolean).join('  ');
  }
  if (process.stdout.isTTY) process.stdout.write(`\r\x1b[2K${head}  ${mark} ${tail}\n`);
  else process.stdout.write(`\n${' '.repeat(head.length)}  ${mark} ${tail}\n`);
}

const elapsed = (Date.now() - started) / 1000;

/* ---------- отчёт ---------- */

const ok = results.filter((r) => r.status === 'ok' || r.status === 'ok_after_retry');
const errors = results.filter((r) => r.status === 'error');
const scoringFailed = results.filter((r) => r.status === 'scoring_failed');
const retried = results.filter((r) => (r.attempts || 1) > 1);
const totalCost = results.reduce((s, r) => s + (r.cost ? r.cost.usd : 0), 0);
const evaluated = results.filter((r) => r.status !== 'error');

console.log(line());
console.log(c.bold('По языкам'));
for (const lang of LANGS) {
  const rs = results.filter((r) => r.language === lang);
  if (!rs.length) continue;
  const good = rs.filter((r) => r.status === 'ok' || r.status === 'ok_after_retry');
  const totals = rs.map((r) => r.total).filter((t) => typeof t === 'number');
  const avg = totals.length ? (totals.reduce((a, b) => a + b, 0) / totals.length).toFixed(2) : '—';
  const mark = good.length === rs.length ? OK : FAIL;
  console.log(`  ${mark} ${lang}  ${good.length}/${rs.length} успешно   средний балл ${avg}`);
}

console.log();
console.log(c.bold('Разбор JSON и правила чек-листа'));
const parseIssues = results.flatMap((r) => (r.issues || []).filter((x) => x.code === 'INVALID_JSON').map(() => r.conversation_id));
const ruleIssues = results.flatMap((r) => (r.issues || []).filter((x) => x.code === 'RULES_VIOLATION').map((x) => ({ id: r.conversation_id, errors: x.errors })));
console.log(`  ${parseIssues.length ? WARN : OK} невалидный JSON от модели: ${parseIssues.length}${parseIssues.length ? ` (${[...new Set(parseIssues)].join(', ')})` : ''}`);
console.log(`  ${ruleIssues.length ? WARN : OK} нарушения правил в ответе модели: ${ruleIssues.length}`);
for (const x of ruleIssues) for (const e of x.errors) console.log(`      ${c.gray(x.id)} ${e}`);
console.log(`  ${retried.length ? WARN : OK} оценок с повторной попыткой: ${retried.length}`);

console.log();
console.log(c.bold('Стиль обоснований (эмоциональная лексика, «!»)'));
const styleHits = results.flatMap((r) => (r.style || []).map((s) => ({ id: r.conversation_id, ...s })));
const styleChecked = results.filter((r) => r.style).length;
console.log(`  ${styleHits.length ? WARN : OK} замечаний: ${styleHits.length} ${c.gray(`(проверено диалогов: ${styleChecked})`)}`);
for (const s of styleHits) console.log(`      ${c.gray(`${s.id} ${s.where}`)} «${s.match}»: ${s.text.slice(0, 90)}`);

console.log();
console.log(c.bold('Формат JSON 1.0 и расчёт итога (N/A, веса, critical_flag)'));
if (!evaluated.length) {
  console.log(`  ${c.gray('нет успешных оценок для проверки')}`);
} else {
  const names = [...new Set(evaluated.flatMap((r) => r.checks.map((x) => x.name)))];
  for (const name of names) {
    const rs = evaluated.filter((r) => r.checks.some((x) => x.name === name));
    const bad = rs.filter((r) => !r.checks.find((x) => x.name === name).ok);
    console.log(`  ${bad.length ? FAIL : OK} ${name}  ${c.gray(`${rs.length - bad.length}/${rs.length}`)}`);
    for (const r of bad) console.log(`      ${c.red(r.conversation_id)} ${r.checks.find((x) => x.name === name).detail}`);
  }
}

if (errors.length) {
  console.log();
  console.log(c.bold(c.red('Ошибки')));
  for (const r of errors) {
    console.log(`  ${FAIL} ${r.conversation_id} ${c.red(r.error_code)} — ${ERROR_HINT[r.error_code] || 'ошибка API'}` +
      (r.error_record_valid === undefined ? '' : r.error_record_valid ? c.gray(' · запись status "error" по формату JSON 1.0') : c.red(' · запись об ошибке не по формату')));
    console.log(`      ${c.gray(r.error.replace(/\n/g, '\n      '))}`);
  }
}

console.log(line('═'));
const allGood = !errors.length && !scoringFailed.length;
const summary = [
  `${ok.length}/${results.length} успешно`,
  `ошибок ${errors.length + scoringFailed.length}`,
  `повторов ${retried.length}`,
  `$${totalCost.toFixed(4)} (≈ $${(totalCost / Math.max(results.length, 1)).toFixed(4)} за диалог)`,
  fmtTime(elapsed),
].join(' · ');
console.log(`${allGood ? OK : FAIL} ${c.bold(allGood ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : 'ЕСТЬ ОШИБКИ')}  ${summary}`);

const outDir = join(DATA_DIR, 'eval_results');
await mkdir(outDir, { recursive: true });
const outFile = join(outDir, `test_runner_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(
  outFile,
  JSON.stringify({ model: MODEL, effort: EFFORT, checklist_id: checklist.id, checklist_version: checklist.version, elapsed_sec: elapsed, total_usd: totalCost, results }, null, 2),
  'utf8'
);
console.log(c.gray(`Отчёт: ${outFile}`));
console.log();
process.exit(allGood ? 0 : 1);
