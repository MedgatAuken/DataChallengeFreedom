// Модуль автоматической оценки диалога по чек-листу (CQA_Chat_Quality_Checklist).
// Формат результата — JSON 1.0 из приложения «Как сдать результаты» (CQA_Student_Guide_Appendix_Results).
//
//   buildSystemPrompt(checklist)         — системный промпт, собирается из конфигурации чек-листа
//   callLLM(record, checklist)           — запрос к Claude, строгий JSON по схеме (structured outputs)
//   computeFinalScore(criteria, cl)      — итог: веса, N/A, округление, флаг грубой ошибки
//   estimateCost(usage, model)           — токены и примерная стоимость в долларах
//   evaluateConversation(record, cl)     — всё вместе; никогда не бросает исключение:
//        { result: <запись JSON 1.0>, meta: { стоимость, попытки, цитаты, разбивка итога … } }
//   buildResultsFile(results)            — файл results.json целиком (schema_version, team_name, model, results)
//   validateResultRecord(record, cl, n)  — проверка записи на соответствие формату JSON 1.0
//
// Ключ берётся из backend/.env (ANTHROPIC_API_KEY) — его подгружает config.js.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { DATA_DIR, STORE_DIR } from './config.js';

export const MODEL = process.env.CQA_MODEL || 'claude-opus-5-5';
// Глубина рассуждений модели: low | medium | high | xhigh | max. Оценка качества — работа на суждение,
// поэтому по умолчанию high; medium/low дешевле (меньше выходных токенов на размышления).
export const EFFORT = process.env.CQA_EFFORT || 'high';

export const SCHEMA_VERSION = '1.0';
export const TEAM_NAME = process.env.CQA_TEAM_NAME || 'room-801';
export const MODEL_MODE = 'external_api'; // local | external_api | hybrid

/* =====================================================================
 * Чек-лист
 * ===================================================================== */

// Коды критериев до перехода на формат JSON 1.0 → коды из приложения организаторов.
export const LEGACY_CRITERION_IDS = {
  c01: 'contact',
  c02: 'discovery',
  c03: 'identification',
  c04: 'consultation',
  c05: 'empathy',
  c06: 'dialogue',
  c07: 'closure',
  c08: 'critical',
};

export const toCriterionId = (id) => LEGACY_CRITERION_IDS[id] || id;

/** Переводит старые коды критериев (c01…c08) в коды JSON 1.0. Возвращает тот же объект. */
export function migrateChecklist(checklist) {
  if (checklist && Array.isArray(checklist.criteria)) {
    for (const c of checklist.criteria) c.id = toCriterionId(c.id);
  }
  return checklist;
}

/** Последний сохранённый через интерфейс чек-лист (или указанный по id); иначе — из PDF организаторов. */
export async function loadChecklist(id) {
  try {
    const docs = Object.values(JSON.parse(await readFile(join(STORE_DIR, 'checklists.json'), 'utf8')));
    const found = id ? docs.find((c) => c.id === id) : docs[docs.length - 1];
    if (found) return migrateChecklist(found);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const def = JSON.parse(await readFile(join(DATA_DIR, 'checklist_default.json'), 'utf8'));
  if (id && def.id !== id) throw new Error(`Чек-лист ${id} не найден`);
  return migrateChecklist(def);
}

const scaleValues = (c) => (c.scale || []).map((s) => Number(s.value)).sort((a, b) => a - b);
const scaleMax = (c) => Math.max(...scaleValues(c));

/** Допустимые значения value для критерия — так, как они записываются в JSON. */
function allowedValues(c) {
  const na = c.na_allowed && c.type !== 'critical' ? ' / null' : '';
  if (c.type === 'scale') return `${scaleValues(c).join(', ')}${na}`;
  return `true / false${na}`;
}

function describeCriterion(c, idx) {
  const kind = c.type === 'scale' ? `шкала 0–${scaleMax(c)}` : c.type === 'critical' ? 'Да/Нет, без баллов' : 'Да/Нет';
  const lines = [
    `### ${String(idx + 1).padStart(2, '0')}. ${c.title}  [criterion_id: ${c.id}; ${kind}; ${c.na_allowed && c.type !== 'critical' ? 'N/A разрешён' : 'N/A запрещён'}; вес ${c.weight || 0}]`,
    c.description,
  ];
  if (c.na_allowed && c.na_condition) lines.push(`N/A — только если: ${c.na_condition}`);
  if (c.type === 'scale') lines.push('Шкала:', ...[...c.scale].sort((a, b) => b.value - a.value).map((s) => `  ${s.value} — ${s.label}`));
  lines.push(`Допустимые value: ${allowedValues(c)}.`);
  return lines.join('\n');
}

/* =====================================================================
 * 1. Системный промпт
 * ===================================================================== */

export function buildSystemPrompt(checklist) {
  const bySection = checklist.sections
    .map((s) => {
      const crit = checklist.criteria.filter((c) => c.section === s.id);
      if (!crit.length) return '';
      return `## ${s.title}\n\n${crit.map((c) => describeCriterion(c, checklist.criteria.indexOf(c))).join('\n\n')}`;
    })
    .filter(Boolean)
    .join('\n\n');
  const ids = checklist.criteria.map((c) => c.id).join(', ');

  return `Ты — специалист отдела контроля качества брокерской компании Freedom Broker. Ты оцениваешь работу ОПЕРАТОРА в одном диалоге с клиентом (чат или расшифровка звонка) строго по чек-листу ниже и возвращаешь результат в формате JSON 1.0 по заданной схеме.

# Входные данные
Ты получаешь JSON: conversation_id, channel ("agent chat" или "voice call"), language (RU, KZ или EN) и transcript — массив реплик. У каждой реплики есть turn, timestamp, speaker и text.
- turn — номер реплики: с 1 по порядку всего транскрипта, включая клиента, бота и системные события. На реплики ссылайся только по turn.
- Роли: client — клиент, operator — оператор, bot — чат-бот, system — системные события (передача оператору, закрытие чата, запуск записи и т. п.).
- Оценивается только оператор. Реплики бота и системные события — контекст: они показывают, что клиент уже сообщил, когда оператор подключился, когда закончился диалог. Приветствие бота не считается приветствием оператора.
- Один и тот же чек-лист применяется к диалогам на русском, казахском и английском. Оценивай по смыслу на языке диалога.
- Порог первой реакции оператора — 3 минуты: учитывай его в оценке скорости и предупреждения об ожидании. Теги и вложения в оценку не входят.

# Чек-лист «${checklist.name}» (версия ${checklist.version})

${bySection}

# «Нет» и «N/A» — это разные ответы
- «Нет» (value = false) — действие БЫЛО НУЖНО, но оператор его пропустил или выполнил неправильно. Пример: требовалась проверка личности перед раскрытием данных или защищённым действием, а в диалоге она не подтверждена — это false, а не null.
- «N/A» (value = null) — критерий НЕПРИМЕНИМ, потому что выполнено условие неприменимости, указанное у критерия. Пример: общий вопрос о тарифах не требует идентификации — identification = null.
- null ставится только у критериев, где N/A разрешён, и только когда условие неприменимости действительно выполнено. Если сомневаешься, было ли действие нужно, — разбери, что именно просил клиент; отсутствие действия само по себе не делает критерий неприменимым.
- У критериев без разрешённого N/A всегда выбирай true/false или ступень шкалы.

# Жёсткое правило: только подтверждённые факты (анти-галлюцинация)
- Засчитывай действие (true или высокую ступень шкалы) только если оно явно подтверждено конкретной репликой оператора или системным сообщением в транскрипте.
- Категорически запрещено додумывать контекст, предполагать намерения оператора или достраивать то, что «вероятно произошло» вне транскрипта. Недопустимые рассуждения: «оператор, видимо, проверил данные в системе», «скорее всего, клиента идентифицировали раньше», «оператор, наверное, хотел предложить помощь».
- Если явного подтверждения нет — ставь false, а по шкале — ступень, соответствующую только тому, что подтверждено в транскрипте. При сомнении между ступенями выбирай более низкую.
- Это правило не отменяет N/A: если условие неприменимости выполнено, ставь null. Неприменимость тоже должна следовать из транскрипта (например, из содержания запроса клиента), а не из предположений.
- Для грубых ошибок (critical) true ставится только при явном нарушении в репликах оператора; подозрение или предположение нарушением не считается.

# Звонки: специфика устной речи
Для channel = "voice call" транскрипт — автоматическая расшифровка устной речи. В нём возможны обрывы фраз, повторы, слова-паразиты («э-э», «ну», «как бы», «короче»), неформальные и разговорные обороты, ошибки распознавания, автоматическая пунктуация и регистр.
- Игнорируй эти артефакты при оценке профессионализма: не снижай за них оценку ни в критерии ведения диалога и грамотности, ни в оценке вежливости. Грамотность в звонке — это понятность и логичность сказанного, а не орфография и пунктуация расшифровки.
- Фокусируйся на сути решения проблемы: понял ли оператор запрос, дал ли верное решение или корректный следующий шаг, выполнил ли обязательные действия (приветствие, проверку личности, завершение).
- Снижай оценку ведения диалога, только если из-за речи оператора клиенту действительно приходится переспрашивать или ход разговора становится непонятным — это должно быть видно по репликам клиента.
- В звонке действие может быть подтверждено разговорной формулировкой: засчитывай его по смыслу, если формулировка однозначна. Правило подтверждённых фактов действует и для звонков.
- Системные сообщения о записи, смене языка транскрипции и т. п. — технический контекст.

# Как разделять консультацию и ведение диалога
Консультация оценивает, правильно и полно ли решён запрос. Ведение диалога оценивает, насколько понятно и последовательно оператор общался. Ясный ответ только на один из двух важных вопросов может получить высокий балл за ведение диалога и частичный — за консультацию.

# Грубые ошибки
Отмечай true, если есть хотя бы одно: оскорбление клиента; предложение платной услуги в обход компании; раскрытие конфиденциальной информации. Предложение в обход компании — это, например, предложение перевести деньги оператору лично для инвестирования или просьба дать личный номер, чтобы оказать платную консультацию частным образом. Достаточно самого предложения — согласие клиента или перевод денег не нужны. Грубые ошибки не дают баллов и отмечаются отдельно.

# Формат ответа (JSON 1.0)
Верни объект из трёх полей: criteria, notes, summary.

1. criteria — массив, по одному объекту на каждый критерий чек-листа (${ids}), каждый ровно один раз, в порядке чек-листа. В объекте ровно четыре поля:
   - criterion_id — код критерия из чек-листа;
   - value — true («Да»), false («Нет»), null (N/A — только где разрешено) или целое число — ступень шкалы до учёта веса (например, dialogue = 7 означает 7 из 10). Не пиши value строкой: не "true", не "Да", не "N/A";
   - rationale — 1–3 предложения на русском языке (независимо от языка диалога): какой ответ и почему, со ссылкой на номера реплик. Образец: «Требование не выполнено: после ответа на вопрос оператор закрыл чат без прощания. Основание — последняя реплика оператора (#9) и сообщение о закрытии чата (#10)». Для N/A объясни, какое условие неприменимости выполнено и чем это подтверждается;
   - evidence_turns — массив целых чисел, номера turn подтверждающих реплик, минимум один. Нумерация — с 1 по всему транскрипту, включая клиента, бота и системные события; не перенумеровывай только реплики оператора. Для пропущенного действия укажи реплику, где оно ожидалось; для N/A — реплику, из которой следует неприменимость.
   Итоговый балл не считай — его рассчитывает система.

2. notes — вспомогательные данные для интерфейса, по одному объекту на каждый критерий:
   - criterion_id — код критерия;
   - quote — точная цитата (на языке оригинала) главной реплики-доказательства; можно сократить многоточием;
   - checked_turns — если value = false, [первый, последний] turn участка, где ты искал это действие; иначе пустой массив.

3. summary — 2–4 предложения: итог работы оператора, ключевые нарушения и критерии N/A.

# Стиль rationale и summary
Пиши строгим корпоративным языком:
- нейтральный деловой стиль, третье лицо («оператор», «клиент»), констатация фактов со ссылкой на номера реплик (#turn);
- без эмоциональных и оценочных слов и оборотов: «отлично», «образцово», «прекрасно», «блестяще», «к сожалению», «увы», «молодец», «ужасно», «грубо проигнорировал» и подобных;
- без восклицательных знаков, иронии, обращений к читателю и предположений о мотивах оператора;
- формулировки вывода: «требование выполнено», «требование не выполнено», «действие не подтверждено в транскрипте», «критерий неприменим: <условие>».

Не придумывай реплики, которых нет в транскрипте.`;
}

/* =====================================================================
 * Схема ответа модели (structured outputs: модель обязана вернуть JSON ровно этой формы)
 * ===================================================================== */

export function buildResponseSchema(checklist) {
  const ids = checklist.criteria.map((c) => c.id);
  return {
    type: 'object',
    additionalProperties: false,
    required: ['criteria', 'notes', 'summary'],
    properties: {
      criteria: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['criterion_id', 'value', 'rationale', 'evidence_turns'],
          properties: {
            criterion_id: { type: 'string', enum: ids },
            value: { anyOf: [{ type: 'boolean' }, { type: 'integer' }, { type: 'null' }] },
            rationale: { type: 'string' },
            evidence_turns: { type: 'array', items: { type: 'integer' } },
          },
        },
      },
      notes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['criterion_id', 'quote', 'checked_turns'],
          properties: {
            criterion_id: { type: 'string', enum: ids },
            quote: { type: 'string' },
            checked_turns: { type: 'array', items: { type: 'integer' } },
          },
        },
      },
      summary: { type: 'string' },
    },
  };
}

/** Проверка value по правилам чек-листа. Возвращает текст ошибки или null. */
function checkValue(c, v) {
  if (v === null) {
    if (!c.na_allowed || c.type === 'critical') return `null (N/A) запрещён — допустимо: ${allowedValues(c)}`;
    return null;
  }
  if (c.type === 'scale') {
    if (!Number.isInteger(v) || !scaleValues(c).includes(v)) return `${JSON.stringify(v)} не является ступенью шкалы (${allowedValues(c)})`;
    return null;
  }
  if (typeof v !== 'boolean') return `ожидается true или false, получено ${JSON.stringify(v)}`;
  return null;
}

function checkTurns(turns, transcriptLength, { required }) {
  if (!Array.isArray(turns)) return 'должен быть массивом номеров реплик';
  if (required && !turns.length) return 'нужен хотя бы один номер реплики';
  const notInt = turns.filter((n) => !Number.isInteger(n));
  if (notInt.length) return `содержит не целые числа: ${notInt.map((n) => JSON.stringify(n)).join(', ')}`;
  const bad = turns.filter((n) => n < 1 || n > transcriptLength);
  if (bad.length) return Number.isFinite(transcriptLength) && transcriptLength < Number.MAX_SAFE_INTEGER
    ? `номера ${bad.join(', ')} вне диапазона 1–${transcriptLength}`
    : `номера ${bad.join(', ')} меньше 1 (нумерация с 1)`;
  return null;
}

/** Проверяет ответ модели на соответствие чек-листу и формату. Возвращает список ошибок (пустой — всё в порядке). */
export function validateLLMResult(parsed, checklist, transcriptLength) {
  const errors = [];
  const items = Array.isArray(parsed?.criteria) ? parsed.criteria : [];
  if (!Array.isArray(parsed?.criteria)) errors.push('В ответе нет массива criteria.');
  for (const c of checklist.criteria) {
    const found = items.filter((x) => x && x.criterion_id === c.id);
    if (found.length !== 1) {
      errors.push(`Критерий ${c.id} «${c.title}» должен встречаться в criteria ровно один раз (найдено: ${found.length}).`);
      continue;
    }
    const valueError = checkValue(c, found[0].value);
    if (valueError) errors.push(`Критерий ${c.id} «${c.title}»: value ${valueError}.`);
    const turnsError = checkTurns(found[0].evidence_turns, transcriptLength, { required: true });
    if (turnsError) errors.push(`Критерий ${c.id}: evidence_turns ${turnsError}.`);
    if (typeof found[0].rationale !== 'string' || !found[0].rationale.trim()) errors.push(`Критерий ${c.id}: пустой rationale.`);
  }
  for (const n of Array.isArray(parsed?.notes) ? parsed.notes : []) {
    const turnsError = checkTurns(n?.checked_turns, transcriptLength, { required: false });
    if (turnsError) errors.push(`notes ${n?.criterion_id}: checked_turns ${turnsError}.`);
  }
  return errors;
}

/* =====================================================================
 * Вызов LLM
 * ===================================================================== */

let client;
function getClient() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new EvaluationError('NO_API_KEY', 'Не задан ANTHROPIC_API_KEY: добавьте его в backend/.env (см. backend/.env.example)');
    }
    client = new Anthropic(); // ключ берётся из окружения (backend/.env загружен в config.js)
  }
  return client;
}

function transcriptPayload(record) {
  return JSON.stringify(
    {
      conversation_id: record.conversation_id,
      channel: record.channel,
      language: record.language,
      // turn — с 1 по исходному массиву транскрипта (включая клиента, бота и события), как требует формат JSON 1.0.
      transcript: record.transcript.map((m, i) => ({ turn: i + 1, timestamp: m.timestamp, speaker: m.speaker, text: m.text })),
    },
    null,
    1
  );
}

/**
 * Ошибка оценки с машинно-читаемым кодом:
 *   INVALID_JSON     — модель вернула текст, который не разбирается как JSON
 *   RULES_VIOLATION  — JSON разобран, но нарушает правила чек-листа или формата
 *   REFUSAL          — модель отказалась отвечать (stop_reason = refusal)
 *   MAX_TOKENS       — ответ обрезан по max_tokens
 *   NO_API_KEY       — не задан ключ API
 * В details.usage — токены всех сделанных вызовов (они оплачены, даже если оценка не удалась).
 */
export class EvaluationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'EvaluationError';
    this.code = code;
    this.details = details;
  }
}

async function requestOnce(messages, checklist) {
  return getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // Системный промпт одинаков для всех диалогов одного чек-листа — помечаем для кэширования.
    system: [{ type: 'text', text: buildSystemPrompt(checklist), cache_control: { type: 'ephemeral' } }],
    messages,
    output_config: {
      effort: EFFORT,
      format: { type: 'json_schema', schema: buildResponseSchema(checklist) },
    },
    // Если классификатор безопасности отклонит запрос, API само повторит его на рекомендованной модели.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  });
}

/**
 * Отправляет транскрипт в Claude и возвращает распарсенный JSON-ответ по схеме.
 * - Невалидный JSON — повторяет тот же запрос.
 * - JSON нарушает правила чек-листа или формата — повторяет запрос с перечнем ошибок.
 * Повторов не больше maxRepairs. Возвращает { parsed, usage: [...], model, attempts, issues }.
 */
export async function callLLM(record, checklist, { maxRepairs = 1 } = {}) {
  const messages = [
    {
      role: 'user',
      content: `Оцени работу оператора в этом диалоге по чек-листу.\n\n<dialog>\n${transcriptPayload(record)}\n</dialog>`,
    },
  ];
  const usage = [];
  const issues = [];
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await requestOnce(messages, checklist);
    } catch (err) {
      err.details = { ...(err.details || {}), usage, issues, attempts: attempt + 1 };
      throw err;
    }
    usage.push({ model: response.model, ...response.usage });
    const details = { usage, issues, attempts: attempt + 1 };

    if (response.stop_reason === 'refusal') {
      throw new EvaluationError('REFUSAL', `Модель отказалась оценивать диалог (${response.stop_details?.category ?? 'без категории'})`, details);
    }
    if (response.stop_reason === 'max_tokens') {
      throw new EvaluationError('MAX_TOKENS', 'Ответ модели обрезан по max_tokens — JSON неполный', details);
    }

    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      issues.push({ code: 'INVALID_JSON', message: err.message, sample: text.slice(0, 200) });
      if (attempt >= maxRepairs) {
        throw new EvaluationError('INVALID_JSON', `Модель вернула невалидный JSON: ${err.message}`, details);
      }
      continue; // тот же запрос ещё раз
    }

    const errors = validateLLMResult(parsed, checklist, record.transcript.length);
    if (!errors.length) return { parsed, usage, model: response.model, attempts: attempt + 1, issues };

    issues.push({ code: 'RULES_VIOLATION', errors });
    if (attempt >= maxRepairs) {
      throw new EvaluationError('RULES_VIOLATION', `Ответ модели не соответствует чек-листу:\n- ${errors.join('\n- ')}`, details);
    }
    messages.push(
      { role: 'assistant', content: response.content },
      { role: 'user', content: `В оценке есть нарушения правил чек-листа или формата JSON 1.0:\n- ${errors.join('\n- ')}\nВерни исправленный ответ целиком.` }
    );
  }
}

/* =====================================================================
 * 2. Расчёт итогового балла (CQA_Chat_Quality_Checklist, стр. 2 «Порядок расчёта»)
 * ===================================================================== */

const round2 = (x, digits = 2) => {
  const f = 10 ** digits;
  return Math.round((x + Number.EPSILON) * f) / f;
};

/**
 * Принимает criteria в формате JSON 1.0 ({ criterion_id, value }).
 * true — полный вес, false — 0; число — пропорционально шкале (верхняя ступень = полный вес).
 * Критерии с value = null (N/A) исключаются, их вес пропорционально перераспределяется между
 * применимыми, так что максимум остаётся 100. Итог округляется до 2 знаков; если применимых
 * критериев с весом нет — final_score = null. Грубая ошибка в расчёт не входит: critical_flag
 * совпадает с value критерия critical и не обнуляет итог.
 */
export function computeFinalScore(criteria, checklist) {
  const digits = Number.isInteger(checklist.rounding) ? checklist.rounding : 2;
  const byId = Object.fromEntries((criteria || []).map((x) => [x.criterion_id, x]));

  const rows = checklist.criteria.map((c) => {
    const value = byId[c.id] ? byId[c.id].value : undefined;
    const weight = Number(c.weight) || 0; // вес берём из конфигурации, а не из ответа модели
    const row = { criterion_id: c.id, section: c.section, title: c.title, value, weight, effective_weight: 0, points: null };
    if (c.type === 'critical') row.status = 'critical';
    else if (!weight) row.status = 'unweighted';
    else if (value === null) row.status = 'na';
    else if (value === undefined) row.status = 'missing';
    else {
      row.status = 'scored';
      row._ratio = c.type === 'scale' ? Number(value) / scaleMax(c) : value === true ? 1 : 0;
    }
    return row;
  });

  const scored = rows.filter((r) => r.status === 'scored');
  const applicableWeight = scored.reduce((s, r) => s + r.weight, 0);

  let finalScore = null;
  if (applicableWeight > 0) {
    let sum = 0;
    for (const r of scored) {
      const effective = (r.weight / applicableWeight) * 100;
      const points = r._ratio * effective;
      sum += points;
      r.effective_weight = round2(effective, digits);
      r.points = round2(points, digits);
    }
    finalScore = round2(sum, digits); // округляем итог от точной суммы, а не от округлённых слагаемых
  }
  rows.forEach((r) => delete r._ratio);

  const criticalFlag = rows.some((r) => r.status === 'critical' && r.value === true);
  const sections = checklist.sections
    .map((s) => {
      const rs = scored.filter((r) => r.section === s.id);
      if (!rs.length) return null;
      return {
        id: s.id,
        title: s.title,
        points: round2(rs.reduce((acc, r) => acc + r.points, 0), digits),
        max: round2(rs.reduce((acc, r) => acc + r.effective_weight, 0), digits),
      };
    })
    .filter(Boolean);

  return {
    final_score: finalScore,
    critical_flag: criticalFlag,
    applicable_weight: applicableWeight,
    na: rows.filter((r) => r.status === 'na').map((r) => r.criterion_id),
    missing: rows.filter((r) => r.status === 'missing').map((r) => r.criterion_id),
    sections,
    rows,
  };
}

/* =====================================================================
 * 3. Токены и стоимость
 * ===================================================================== */

// Цены за 1 млн токенов в USD (тарифы Anthropic API). cacheWrite — запись в кэш на 5 минут (1.25× входа).
export const PRICING = {
  'claude-opus-5-5': { input: 4.0, output: 20.0, cacheRead: 0.2 },
  'claude-opus-5': { input: 5.0, output: 25.0, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2.0, output: 10.0, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2.0, output: 10.0, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-fable-5-1': { input: 10.0, output: 50.0, cacheRead: 0.25 },
  'claude-opus-4-8': { input: 5.0, output: 25.0, cacheRead: 0.5 },
};

/**
 * Считает токены и стоимость по одному или нескольким вызовам (повторная попытка тоже оплачивается).
 * output_tokens включают токены размышлений модели — они тарифицируются как выходные.
 */
export function estimateCost(usageList, fallbackModel = MODEL) {
  const list = Array.isArray(usageList) ? usageList : [usageList];
  const totals = { calls: list.length, input_tokens: 0, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, usd: 0 };
  for (const u of list) {
    const model = u.model || fallbackModel;
    const p = PRICING[model];
    if (!p) throw new Error(`Нет тарифа для модели ${model} — добавьте её в PRICING`);
    const input = u.input_tokens || 0;
    const output = u.output_tokens || 0;
    const cacheWrite = u.cache_creation_input_tokens || 0;
    const cacheRead = u.cache_read_input_tokens || 0;
    totals.input_tokens += input;
    totals.output_tokens += output;
    totals.cache_write_tokens += cacheWrite;
    totals.cache_read_tokens += cacheRead;
    totals.usd += (input * p.input + output * p.output + cacheWrite * p.input * 1.25 + cacheRead * p.cacheRead) / 1e6;
  }
  totals.usd = Math.round(totals.usd * 1e6) / 1e6;
  totals.model = [...new Set(list.map((u) => u.model || fallbackModel))].join(', ');
  return totals;
}

/* =====================================================================
 * 4. Запись JSON 1.0
 * ===================================================================== */

const uniqSortedTurns = (turns) => [...new Set(turns)].sort((a, b) => a - b);

/** criteria в порядке чек-листа, ровно четыре поля, номера реплик без повторов и по возрастанию. */
function toResultCriteria(llmCriteria, checklist) {
  const byId = Object.fromEntries(llmCriteria.map((x) => [x.criterion_id, x]));
  return checklist.criteria.map((c) => ({
    criterion_id: c.id,
    value: byId[c.id].value,
    rationale: byId[c.id].rationale.trim(),
    evidence_turns: uniqSortedTurns(byId[c.id].evidence_turns),
  }));
}

const ERROR_REASON = {
  INVALID_JSON: 'Модель вернула невалидный JSON после повторной попытки.',
  RULES_VIOLATION: 'Ответ модели не прошёл проверку по правилам чек-листа после повторной попытки.',
  REFUSAL: 'Модель отказалась оценивать диалог.',
  MAX_TOKENS: 'Ответ модели обрезан: превышен лимит длины ответа.',
  NO_API_KEY: 'Не задан ключ API модели.',
};

export function errorCode(err) {
  if (err && err.code) return err.code;
  if (err && err.status) return `API_${err.status}`;
  if (/timeout/i.test(err?.name || '')) return 'API_TIMEOUT';
  if (/connection/i.test(err?.name || '')) return 'API_CONNECTION';
  return 'EVALUATION_FAILED';
}

/** Запись об ошибке по формату приложения: status = "error", пустой criteria, score = null, причина в error. */
export function errorResult(conversationId, err) {
  const code = errorCode(err);
  // У ошибок API в message — сырой JSON ответа; берём из него только текст.
  const apiMessage = err?.error?.error?.message || err?.error?.message;
  const detail = err?.status && apiMessage ? `ошибка API модели (HTTP ${err.status}): ${apiMessage}` : String(err?.message || err).split('\n')[0];
  const reason = ERROR_REASON[code] || `Не удалось получить ответ модели: ${detail.slice(0, 200)}`;
  return { conversation_id: conversationId, status: 'error', criteria: [], score: null, error: reason };
}

/**
 * Оценивает диалог. Никогда не бросает исключение.
 * Возвращает { result, meta }:
 *   result — запись строго по формату JSON 1.0 (status "ok" или "error");
 *   meta   — служебные данные: модель, попытки, время, стоимость, цитаты и участки (notes),
 *            резюме, разбивка итога по критериям и секциям (breakdown), код ошибки.
 */
export async function evaluateConversation(record, checklist) {
  const started = Date.now();
  const meta = { checklist_id: checklist.id, checklist_version: checklist.version, model: MODEL, effort: EFFORT };
  try {
    const { parsed, usage, model, attempts, issues } = await callLLM(record, checklist);
    const criteria = toResultCriteria(parsed.criteria, checklist);
    const breakdown = computeFinalScore(criteria, checklist);
    const notes = Object.fromEntries(
      (parsed.notes || []).map((n) => [n.criterion_id, { quote: n.quote || '', checked_turns: uniqSortedTurns(n.checked_turns || []) }])
    );
    return {
      result: {
        conversation_id: record.conversation_id,
        status: 'ok',
        criteria,
        score: { final_score: breakdown.final_score, critical_flag: breakdown.critical_flag },
      },
      meta: {
        ...meta,
        model,
        attempts,
        issues,
        seconds: round2((Date.now() - started) / 1000, 1),
        cost: estimateCost(usage, model),
        summary: parsed.summary || '',
        notes,
        breakdown,
      },
    };
  } catch (err) {
    const usage = err.details?.usage;
    return {
      result: errorResult(record.conversation_id, err),
      meta: {
        ...meta,
        error_code: errorCode(err),
        error_detail: String(err?.message || err),
        attempts: err.details?.attempts ?? 0,
        issues: err.details?.issues ?? [],
        seconds: round2((Date.now() - started) / 1000, 1),
        cost: usage && usage.length ? estimateCost(usage) : null,
      },
    };
  }
}

/**
 * { result, meta } → документ оценки для интерфейса (коллекция evaluations).
 * value: null (N/A) → 'NA' — так фронтенд отличает N/A от «нет ответа». Номера реплик — с 1.
 * Исходная запись JSON 1.0 сохраняется в поле result — её можно выгружать в results.json как есть.
 */
export function toEvaluationDoc({ result, meta }, groupId) {
  const answers = {};
  for (const c of result.criteria) {
    const note = (meta.notes && meta.notes[c.criterion_id]) || { quote: '', checked_turns: [] };
    answers[c.criterion_id] = {
      value: c.value === null ? 'NA' : c.value,
      explanation: c.rationale,
      quote: note.quote,
      evidence: c.evidence_turns,
      checked_range: note.checked_turns.length ? [note.checked_turns[0], note.checked_turns.at(-1)] : null,
    };
  }
  return {
    id: `${groupId}__${result.conversation_id}__${meta.checklist_id}`,
    group_id: groupId,
    conversation_id: result.conversation_id,
    checklist_id: meta.checklist_id,
    checklist_version: meta.checklist_version,
    answers,
    summary: meta.summary,
    total: result.score.final_score,
    has_critical: result.score.critical_flag,
    model: meta.model,
    attempts: meta.attempts,
    duration_sec: meta.seconds,
    cost: meta.cost,
    source: 'llm',
    turn_base: 1,
    result, // запись в формате JSON 1.0
  };
}

/** Файл results.json целиком: один объект, в results — все диалоги набора. */
export function buildResultsFile(results, { teamName = TEAM_NAME, modelName = MODEL, mode = MODEL_MODE } = {}) {
  return { schema_version: SCHEMA_VERSION, team_name: teamName, model: { mode, name: modelName }, results };
}

/**
 * Проверка одной записи на соответствие формату JSON 1.0 (названия полей, коды, типы, номера реплик).
 * transcriptLength — если передан, номера реплик проверяются на диапазон.
 */
export function validateResultRecord(r, checklist, transcriptLength) {
  const errors = [];
  if (!r || typeof r !== 'object') return ['запись не является объектом'];
  if (typeof r.conversation_id !== 'string' || !r.conversation_id) errors.push('нет conversation_id');
  if (r.status === 'error') {
    const keys = Object.keys(r).sort().join(',');
    if (keys !== 'conversation_id,criteria,error,score,status') errors.push(`лишние или отсутствующие поля: ${keys}`);
    if (!Array.isArray(r.criteria) || r.criteria.length) errors.push('criteria должен быть пустым массивом');
    if (r.score !== null) errors.push('score должен быть null');
    if (typeof r.error !== 'string' || !r.error) errors.push('нет текста error');
    return errors;
  }
  if (r.status !== 'ok') return [...errors, `status должен быть "ok" или "error", получено ${JSON.stringify(r.status)}`];
  const keys = Object.keys(r).sort().join(',');
  if (keys !== 'conversation_id,criteria,score,status') errors.push(`лишние или отсутствующие поля: ${keys}`);
  if (!Array.isArray(r.criteria)) return [...errors, 'criteria должен быть массивом'];
  for (const c of checklist.criteria) {
    const found = r.criteria.filter((x) => x.criterion_id === c.id);
    if (found.length !== 1) {
      errors.push(`${c.id}: встречается ${found.length} раз`);
      continue;
    }
    const x = found[0];
    const ck = Object.keys(x).sort().join(',');
    if (ck !== 'criterion_id,evidence_turns,rationale,value') errors.push(`${c.id}: поля ${ck}`);
    const ve = checkValue(c, x.value);
    if (ve) errors.push(`${c.id}: value ${ve}`);
    if (typeof x.rationale !== 'string' || !x.rationale) errors.push(`${c.id}: нет rationale`);
    const te = checkTurns(x.evidence_turns, transcriptLength ?? Number.MAX_SAFE_INTEGER, { required: false });
    if (te) errors.push(`${c.id}: evidence_turns ${te}`);
  }
  const extra = r.criteria.filter((x) => !checklist.criteria.some((c) => c.id === x.criterion_id));
  if (extra.length) errors.push(`лишние критерии: ${extra.map((x) => x.criterion_id).join(', ')}`);
  if (!r.score || typeof r.score !== 'object') errors.push('нет score');
  else {
    const sk = Object.keys(r.score).sort().join(',');
    if (sk !== 'critical_flag,final_score') errors.push(`score: поля ${sk}`);
    const fs = r.score.final_score;
    if (fs !== null && !(typeof fs === 'number' && fs >= 0 && fs <= 100 && Math.round(fs * 100) === Math.round(fs * 100 * 1e6) / 1e6)) {
      errors.push(`final_score ${fs}: нужно число 0–100 с округлением до 2 знаков`);
    }
    const critical = r.criteria.find((x) => x.criterion_id === 'critical');
    if (typeof r.score.critical_flag !== 'boolean') errors.push('critical_flag должен быть true или false');
    else if (critical && critical.value !== r.score.critical_flag) errors.push('critical_flag не совпадает с value критерия critical');
  }
  return errors;
}
