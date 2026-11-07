// Модуль автоматической оценки диалога по чек-листу (CQA_Chat_Quality_Checklist).
//
//   buildSystemPrompt(checklist)        — системный промпт, собирается из конфигурации чек-листа
//   callLLM(record, checklist)          — запрос к Claude, строгий JSON по схеме (structured outputs)
//   computeFinalScore(llmResult, cl)    — пересчёт итога: веса, N/A, округление, флаг грубой ошибки
//   estimateCost(usage, model)          — токены и примерная стоимость в долларах
//   evaluateConversation(record, cl)    — всё вместе: оценка + итог + стоимость
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

const NA_LABEL = 'N/A';

/* =====================================================================
 * Чек-лист
 * ===================================================================== */

/** Последний сохранённый через интерфейс чек-лист (или указанный по id); иначе — из PDF организаторов. */
export async function loadChecklist(id) {
  try {
    const docs = Object.values(JSON.parse(await readFile(join(STORE_DIR, 'checklists.json'), 'utf8')));
    const found = id ? docs.find((c) => c.id === id) : docs[docs.length - 1];
    if (found) return found;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const def = JSON.parse(await readFile(join(DATA_DIR, 'checklist_default.json'), 'utf8'));
  if (id && def.id !== id) throw new Error(`Чек-лист ${id} не найден`);
  return def;
}

const scaleValues = (c) => (c.scale || []).map((s) => Number(s.value)).sort((a, b) => b - a);
const scaleMax = (c) => Math.max(...scaleValues(c));

function answerFormat(c) {
  if (c.type === 'scale') {
    return `балл — одно из чисел ${scaleValues(c).join(', ')}${c.na_allowed ? ', либо "N/A"' : ''}`;
  }
  if (c.type === 'critical') return '"Да" (нарушение выявлено) или "Нет"';
  return `"Да" или "Нет"${c.na_allowed ? ', либо "N/A"' : ''}`;
}

function describeCriterion(c, idx) {
  const kind =
    c.type === 'scale' ? `шкала 0–${scaleMax(c)}` : c.type === 'critical' ? 'Да/Нет, без баллов' : 'Да/Нет';
  const lines = [
    `### ${String(idx + 1).padStart(2, '0')}. ${c.title}  [id: ${c.id}; ${kind}; ${c.na_allowed ? 'N/A разрешён' : 'N/A запрещён'}; вес ${c.weight || 0}]`,
    c.description,
  ];
  if (c.na_allowed && c.na_condition) lines.push(`N/A — только если: ${c.na_condition}`);
  if (c.type === 'scale') lines.push('Шкала:', ...c.scale.map((s) => `  ${s.value} — ${s.label}`));
  lines.push(`Допустимая «оценка»: ${answerFormat(c)}.`);
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

  return `Ты — специалист отдела контроля качества брокерской компании Freedom Broker. Ты оцениваешь работу ОПЕРАТОРА в одном диалоге с клиентом (чат или расшифровка звонка) строго по чек-листу ниже и возвращаешь результат в виде JSON по заданной схеме.

# Входные данные
Ты получаешь JSON: conversation_id, channel ("agent chat" или "voice call"), language (RU, KZ или EN) и transcript — массив реплик. У каждой реплики есть номер n (с нуля), timestamp, speaker и text. Роли: client — клиент, operator — оператор, bot — чат-бот, system — системные события (передача оператору, закрытие чата, запуск записи и т. п.).
- Оценивается только оператор. Реплики бота и системные события — контекст: они показывают, что клиент уже сообщил, когда оператор подключился, когда закончился диалог. Приветствие бота не считается приветствием оператора.
- Один и тот же чек-лист применяется к диалогам на русском, казахском и английском. Оценивай по смыслу на языке диалога.
- Порог первой реакции оператора — 3 минуты: учитывай его в оценке скорости и предупреждения об ожидании. Теги и вложения в оценку не входят.

# Чек-лист «${checklist.name}» (версия ${checklist.version})

${bySection}

# «Нет» и «N/A» — это разные ответы
- «Нет» — действие БЫЛО НУЖНО, но оператор его пропустил или выполнил неправильно. Пример: требовалась проверка личности перед раскрытием данных или защищённым действием, а в диалоге она не подтверждена — это «Нет», а не «N/A».
- «N/A» — критерий НЕПРИМЕНИМ, потому что выполнено условие неприменимости, указанное у критерия. Пример: общий вопрос о тарифах не требует идентификации — это «N/A» по критерию «Идентификация».
- Ставь «N/A» только у критериев, где он разрешён, и только когда условие неприменимости действительно выполнено. Если сомневаешься, было ли действие нужно, — разбери, что именно просил клиент; отсутствие действия само по себе не делает критерий неприменимым.
- У критериев без разрешённого N/A всегда выбирай «Да»/«Нет» или ступень шкалы.

# Как разделять консультацию и ведение диалога
Консультация оценивает, правильно и полно ли решён запрос. Ведение диалога оценивает, насколько понятно и последовательно оператор общался. Ясный ответ только на один из двух важных вопросов может получить высокий балл за ведение диалога и частичный — за консультацию.

# Грубые ошибки
Отмечай «Да», если есть хотя бы одно: оскорбление клиента; предложение платной услуги в обход компании; раскрытие конфиденциальной информации. Предложение в обход компании — это, например, предложение перевести деньги оператору лично для инвестирования или просьба дать личный номер, чтобы оказать платную консультацию частным образом. Достаточно самого предложения — согласие клиента или перевод денег не нужны. Грубые ошибки не дают баллов и отмечаются отдельно.

# Обоснование и доказательства
Для каждого критерия:
- «обоснование» — 1–3 предложения на русском языке (независимо от языка диалога): какой ответ и почему, со ссылкой на номера реплик. Образец: «Завершение — Нет. После ответа на вопрос оператор закрыл чат без прощания. Основание — последняя реплика оператора (#9) и сообщение о закрытии чата (#10)».
- «реплика_доказательство» — точная цитата (на языке оригинала) реплики или системного сообщения, на которых основан вывод; можно сократить многоточием. Если действие пропущено, процитируй реплику, где оно ожидалось (например, первый ответ оператора без приветствия).
- «номера_реплик» — номера n реплик-доказательств.
- «проверенный_участок» — если действие пропущено («Нет»), укажи [первый, последний] номер реплик участка, где ты искал это действие; в остальных случаях — пустой массив.
- Для «N/A» в обосновании объясни, какое условие неприменимости выполнено и чем это подтверждается.
- «исходный_вес» — вес критерия из чек-листа (без перераспределения).
Не придумывай реплики, которых нет в транскрипте. Включи в ответ все критерии чек-листа, каждый ровно один раз, в порядке чек-листа.`;
}

/* =====================================================================
 * Схема ответа (structured outputs: модель обязана вернуть JSON ровно этой формы)
 * ===================================================================== */

export function buildResponseSchema(checklist) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['критерии', 'резюме'],
    properties: {
      критерии: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'критерий', 'оценка', 'исходный_вес', 'обоснование', 'реплика_доказательство', 'номера_реплик', 'проверенный_участок'],
          properties: {
            id: { type: 'string', enum: checklist.criteria.map((c) => c.id) },
            критерий: { type: 'string' },
            оценка: {
              anyOf: [{ type: 'string', enum: ['Да', 'Нет', NA_LABEL] }, { type: 'integer' }],
            },
            исходный_вес: { type: 'number' },
            обоснование: { type: 'string' },
            реплика_доказательство: { type: 'string' },
            номера_реплик: { type: 'array', items: { type: 'integer' } },
            проверенный_участок: { type: 'array', items: { type: 'integer' } },
          },
        },
      },
      резюме: { type: 'string' },
    },
  };
}

/** Проверяет ответ модели на соответствие чек-листу. Возвращает список ошибок (пустой — всё в порядке). */
export function validateLLMResult(result, checklist, transcriptLength) {
  const errors = [];
  const items = Array.isArray(result?.критерии) ? result.критерии : [];
  for (const c of checklist.criteria) {
    const found = items.filter((x) => x.id === c.id);
    if (found.length !== 1) {
      errors.push(`Критерий ${c.id} «${c.title}» должен встречаться ровно один раз (найдено: ${found.length}).`);
      continue;
    }
    const v = found[0].оценка;
    if (v === NA_LABEL) {
      if (!c.na_allowed) errors.push(`Критерий ${c.id} «${c.title}»: N/A запрещён — выберите ${answerFormat(c)}.`);
    } else if (c.type === 'scale') {
      if (!scaleValues(c).includes(v)) errors.push(`Критерий ${c.id} «${c.title}»: балл ${JSON.stringify(v)} не является ступенью шкалы (${scaleValues(c).join(', ')}).`);
    } else if (v !== 'Да' && v !== 'Нет') {
      errors.push(`Критерий ${c.id} «${c.title}»: ожидается "Да" или "Нет", получено ${JSON.stringify(v)}.`);
    }
    for (const n of [...(found[0].номера_реплик || []), ...(found[0].проверенный_участок || [])]) {
      if (n < 0 || n >= transcriptLength) errors.push(`Критерий ${c.id}: реплики #${n} нет в транскрипте (0–${transcriptLength - 1}).`);
    }
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
      throw new Error('Не задан ANTHROPIC_API_KEY: добавьте его в backend/.env (см. backend/.env.example)');
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
      transcript: record.transcript.map((m, n) => ({ n, timestamp: m.timestamp, speaker: m.speaker, text: m.text })),
    },
    null,
    1
  );
}

async function requestOnce(messages, checklist) {
  const response = await getClient().beta.messages.create({
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

  if (response.stop_reason === 'refusal') {
    throw new Error(`Модель отказалась оценивать диалог (${response.stop_details?.category ?? 'без категории'})`);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Ответ модели обрезан по max_tokens — JSON неполный');
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Модель вернула невалидный JSON');
  }
  return { response, parsed };
}

/**
 * Отправляет транскрипт в Claude и возвращает распарсенный JSON-ответ по схеме.
 * Если ответ нарушает правила чек-листа (например, N/A там, где он запрещён), делает одну
 * повторную попытку с перечнем ошибок. Возвращает { result, usage: [...], model }.
 */
export async function callLLM(record, checklist, { maxRepairs = 1 } = {}) {
  const messages = [
    {
      role: 'user',
      content: `Оцени работу оператора в этом диалоге по чек-листу.\n\n<dialog>\n${transcriptPayload(record)}\n</dialog>`,
    },
  ];
  const usage = [];
  for (let attempt = 0; ; attempt++) {
    const { response, parsed } = await requestOnce(messages, checklist);
    usage.push({ model: response.model, ...response.usage });
    const errors = validateLLMResult(parsed, checklist, record.transcript.length);
    if (!errors.length) return { result: parsed, usage, model: response.model, attempts: attempt + 1 };
    if (attempt >= maxRepairs) {
      throw new Error(`Ответ модели не соответствует чек-листу:\n- ${errors.join('\n- ')}`);
    }
    messages.push(
      { role: 'assistant', content: response.content },
      { role: 'user', content: `В оценке есть нарушения правил чек-листа:\n- ${errors.join('\n- ')}\nВерни исправленную оценку целиком.` }
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
 * «Да» — полный вес, «Нет» — 0; шкала — пропорционально (верхняя ступень = полный вес).
 * Веса критериев с N/A исключаются и пропорционально перераспределяются между применимыми,
 * так что максимум остаётся 100. Итог округляется до 2 знаков; если применимых критериев с весом
 * нет — итог не рассчитывается (null). Грубые ошибки в расчёт не входят и выводятся отдельным флагом.
 */
export function computeFinalScore(llmResult, checklist) {
  const digits = Number.isInteger(checklist.rounding) ? checklist.rounding : 2;
  const byId = Object.fromEntries((llmResult.критерии || []).map((x) => [x.id, x]));

  const rows = checklist.criteria.map((c) => {
    const a = byId[c.id] || {};
    const weight = Number(c.weight) || 0; // вес берём из конфигурации, а не из ответа модели
    const row = {
      id: c.id,
      секция: c.section,
      критерий: c.title,
      оценка: a.оценка,
      исходный_вес: weight,
      эффективный_вес: 0,
      баллы: null,
      обоснование: a.обоснование ?? '',
      реплика_доказательство: a.реплика_доказательство ?? '',
      номера_реплик: a.номера_реплик ?? [],
      проверенный_участок: a.проверенный_участок ?? [],
    };
    if (c.type === 'critical') row.статус = 'грубая_ошибка';
    else if (!weight) row.статус = 'без_веса';
    else if (a.оценка === NA_LABEL) row.статус = 'N/A';
    else {
      row.статус = 'применим';
      row._доля = c.type === 'scale' ? Number(a.оценка) / scaleMax(c) : a.оценка === 'Да' ? 1 : 0;
    }
    return row;
  });

  const applicable = rows.filter((r) => r.статус === 'применим');
  const applicableWeight = applicable.reduce((s, r) => s + r.исходный_вес, 0);

  let total = null;
  if (applicableWeight > 0) {
    let sum = 0;
    for (const r of applicable) {
      const effective = (r.исходный_вес / applicableWeight) * 100;
      const points = r._доля * effective;
      sum += points;
      r.эффективный_вес = round2(effective, digits);
      r.баллы = round2(points, digits);
    }
    total = round2(sum, digits); // округляем итог от точной суммы, а не от округлённых слагаемых
  }
  rows.forEach((r) => delete r._доля);

  const criticalRows = rows.filter((r) => r.статус === 'грубая_ошибка' && r.оценка === 'Да');
  const sections = checklist.sections
    .map((s) => {
      const rs = applicable.filter((r) => r.секция === s.id);
      if (!rs.length) return null;
      return {
        id: s.id,
        секция: s.title,
        баллы: round2(rs.reduce((acc, r) => acc + r.баллы, 0), digits),
        максимум: round2(rs.reduce((acc, r) => acc + r.эффективный_вес, 0), digits),
      };
    })
    .filter(Boolean);

  return {
    итоговый_балл: total,
    максимум: 100,
    сумма_применимых_весов: applicableWeight,
    na_критерии: rows.filter((r) => r.статус === 'N/A').map((r) => r.id),
    грубая_ошибка: criticalRows.length > 0,
    грубые_ошибки: criticalRows.map((r) => ({ id: r.id, обоснование: r.обоснование, реплика_доказательство: r.реплика_доказательство })),
    секции: sections,
    критерии: rows,
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
  const totals = { вызовов: list.length, input_tokens: 0, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, usd: 0 };
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
  totals.модель = [...new Set(list.map((u) => u.model || fallbackModel))].join(', ');
  return totals;
}

/* =====================================================================
 * Полный цикл
 * ===================================================================== */

export async function evaluateConversation(record, checklist) {
  const started = Date.now();
  const { result, usage, model, attempts } = await callLLM(record, checklist);
  return {
    conversation_id: record.conversation_id,
    checklist_id: checklist.id,
    checklist_version: checklist.version,
    модель: model,
    попыток: attempts,
    время_сек: round2((Date.now() - started) / 1000, 1),
    оценка_llm: result,
    итог: computeFinalScore(result, checklist),
    стоимость: estimateCost(usage, model),
  };
}
