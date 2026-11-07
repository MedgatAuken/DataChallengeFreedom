/* CQA — Conversation Quality Analytics, фронтенд.
 *
 * Чистый JavaScript без сборки. Весь код в одном пространстве имён window.CQA,
 * интерфейс монтируется в #cqa-app — так его проще перенести в HTML web resource Dynamics 365.
 * Адрес API задаётся через window.CQA_CONFIG = { apiBase: '...' } до подключения скрипта.
 *
 * Экран «Оценка» состоит из двух зон:
 *   слева  — «Настройка чек-листа» (критерии, веса, N/A, сохранение версии);
 *   справа — «Анализ диалога» (выбор диалога, транскрипт, кнопка «Оценить оператора», результат).
 */
(function (root) {
  'use strict';

  // Если index.html открыт как файл (file://), обращаемся к локальному серверу напрямую — он разрешает CORS.
  const openedAsFile = Boolean(root.location && root.location.protocol === 'file:');
  const CONFIG = Object.assign(
    { apiBase: openedAsFile ? 'http://localhost:3000/api' : '/api', groupId: 'DEV' },
    root.CQA_CONFIG || {}
  );

  /* =====================================================================
   * 1. Расчёт итогового балла (чистые функции, без DOM)
   *    Правила из CQA_Chat_Quality_Checklist, стр. 2 «Порядок расчёта».
   * ===================================================================== */

  const NA = 'NA';

  /**
   * Значение ответа в формате JSON 1.0 → внутреннее значение интерфейса.
   * true = «Да», false = «Нет», null = N/A, число = ступень шкалы. Внутри N/A хранится как 'NA',
   * чтобы отличать его от «ответа ещё нет» (undefined). null из JSON 1.0 тоже означает N/A —
   * ни в подписи, ни в расчёте он не может превратиться в «Нет» или пропуск.
   */
  const normValue = (v) => (v === null || v === NA ? NA : v);

  function roundTo(x, digits) {
    const f = Math.pow(10, digits);
    return Math.round((x + Number.EPSILON) * f) / f;
  }

  function scaleMax(criterion) {
    return Math.max(...(criterion.scale || []).map((s) => Number(s.value)));
  }

  /**
   * @param checklist  { criteria: [...], sections: [...], rounding }
   * @param answers    { [criterionId]: { value: true | false | number | null | 'NA', ... } } — null и 'NA' = N/A
   * @returns { total, max, complete, rows, sections, critical_errors, has_critical }
   *   total = null, если применимых критериев с весом нет.
   */
  function computeScore(checklist, answers) {
    const digits = Number.isInteger(checklist.rounding) ? checklist.rounding : 2;
    const rows = [];
    const critical = [];
    let applicableWeight = 0;
    let complete = true;

    for (const c of checklist.criteria) {
      const value = answers[c.id] ? normValue(answers[c.id].value) : undefined;
      const row = { id: c.id, section: c.section, value, weight: Number(c.weight) || 0 };

      if (c.type === 'critical') {
        row.kind = 'critical';
        if (value === true) critical.push(c.id);
        if (value === undefined) complete = false;
      } else if (!row.weight) {
        row.kind = 'unweighted';
      } else if (value === NA) {
        row.kind = c.na_allowed ? 'na' : 'invalid_na'; // N/A только там, где он разрешён
        if (!c.na_allowed) complete = false;
      } else if (value === undefined) {
        row.kind = 'missing';
        complete = false;
      } else {
        row.kind = 'scored';
        // «Да» — полный вес, «Нет» — ноль; шкала — пропорционально, верхняя ступень = полный вес.
        row.ratio = c.type === 'scale' ? Number(value) / scaleMax(c) : value === true ? 1 : 0;
        applicableWeight += row.weight;
      }
      rows.push(row);
    }

    // Перераспределение веса N/A пропорционально между применимыми критериями (максимум = 100).
    let total = null;
    if (applicableWeight > 0) {
      let sum = 0;
      for (const r of rows) {
        if (r.kind !== 'scored') continue;
        r.effective_weight = (r.weight / applicableWeight) * 100;
        r.points = r.ratio * r.effective_weight;
        sum += r.points;
      }
      total = roundTo(sum, digits);
    }

    const sections = (checklist.sections || []).map((s) => {
      const scored = rows.filter((r) => r.section === s.id && r.kind === 'scored');
      return {
        id: s.id,
        title: s.title,
        points: scored.length ? roundTo(scored.reduce((a, r) => a + r.points, 0), digits) : null,
        max: scored.length ? roundTo(scored.reduce((a, r) => a + r.effective_weight, 0), digits) : null,
      };
    });

    return { total, max: 100, complete, rows, sections, critical_errors: critical, has_critical: critical.length > 0 };
  }

  /* =====================================================================
   * 2. API
   * ===================================================================== */

  /** Ошибка запроса с машинно-читаемым кодом (TIMEOUT, NETWORK, BAD_RESPONSE, INVALID_JSON, API_429, …). */
  class ApiError extends Error {
    constructor(message, { code = null, status = 0 } = {}) {
      super(message);
      this.name = 'ApiError';
      this.code = code;
      this.status = status;
    }
  }

  const TIMEOUT_MS = {
    default: CONFIG.requestTimeoutMs || 20000,
    evaluate: CONFIG.evaluateTimeoutMs || 150000, // оценка с повтором может занять > 1 мин
    sync: CONFIG.syncTimeoutMs || 120000,
  };

  /**
   * Запрос к локальному серверу. Никогда не возвращает «сырую» ошибку браузера:
   * таймаут, обрыв сети, не-JSON или ошибочный статус превращаются в ApiError с кодом.
   */
  async function request(method, path, body, { timeout = TIMEOUT_MS.default } = {}) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
    try {
      let res;
      try {
        res = await fetch(CONFIG.apiBase + path, {
          method,
          headers: body ? { 'content-type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
          signal: ctrl ? ctrl.signal : undefined,
        });
      } catch (err) {
        if (err && err.name === 'AbortError') {
          throw new ApiError(`Сервер не ответил за ${Math.round(timeout / 1000)} с`, { code: 'TIMEOUT' });
        }
        throw new ApiError('Нет связи с сервером', { code: 'NETWORK' });
      }

      let text = '';
      try {
        text = await res.text();
      } catch (err) {
        if (err && err.name === 'AbortError') {
          throw new ApiError(`Сервер не ответил за ${Math.round(timeout / 1000)} с`, { code: 'TIMEOUT', status: res.status });
        }
        throw new ApiError('Ответ сервера прерван', { code: 'BAD_RESPONSE', status: res.status });
      }
      let data = null;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = null; // неполный или не-JSON ответ
      }

      if (!res.ok) {
        throw new ApiError((data && data.error) || `HTTP ${res.status}`, { code: (data && data.code) || `HTTP_${res.status}`, status: res.status });
      }
      if (data === null || typeof data !== 'object') {
        throw new ApiError('Сервер вернул неполный ответ', { code: 'BAD_RESPONSE', status: res.status });
      }
      return data;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const q = (groupId) => `?group_id=${encodeURIComponent(groupId)}`;
  const api = {
    syncDataset: (g) => request('POST', `/dataset/sync${q(g)}`, null, { timeout: TIMEOUT_MS.sync }),
    conversations: (g) => request('GET', `/conversations${q(g)}`),
    conversation: (g, id) => request('GET', `/conversations/${encodeURIComponent(id)}${q(g)}`),
    audioUrl: (g, id) => `${CONFIG.apiBase}/audio/${encodeURIComponent(id)}${q(g)}`,
    list: (col) => request('GET', `/store/${col}`),
    put: (col, doc) => request('PUT', `/store/${col}/${encodeURIComponent(doc.id)}`, doc),
    evaluate: (payload) => request('POST', '/evaluate', payload, { timeout: TIMEOUT_MS.evaluate }),
  };

  /* ---------- понятные сообщения об ошибках ---------- */

  const NOT_CONFIDENT = 'Недостаточно данных для уверенного вывода';
  const ERROR_TEXT = {
    INVALID_JSON: [NOT_CONFIDENT, 'Модель вернула неполный ответ. Попробуйте повторить запрос.'],
    RULES_VIOLATION: [NOT_CONFIDENT, 'Ответ модели не прошёл проверку по правилам чек-листа. Попробуйте повторить запрос.'],
    MAX_TOKENS: [NOT_CONFIDENT, 'Ответ модели оказался обрезан. Попробуйте повторить запрос.'],
    INCOMPLETE: [NOT_CONFIDENT, 'Результат оценки пришёл не полностью. Попробуйте повторить запрос.'],
    BAD_RESPONSE: ['Сервер вернул неполный ответ', 'Попробуйте повторить запрос.'],
    REFUSAL: ['Модель не смогла оценить диалог', 'Попробуйте повторить запрос или оцените диалог вручную.'],
    TIMEOUT: ['Сервис не ответил вовремя', 'Попробуйте повторить запрос. Если оценка всё же завершится, она появится после обновления страницы.'],
    API_TIMEOUT: ['Сервис оценки не ответил вовремя', 'Попробуйте повторить запрос через минуту.'],
    NETWORK: ['Нет связи с сервером', 'Проверьте, что локальный сервер запущен: npm start в папке backend.'],
    API_CONNECTION: ['Сервер не смог связаться с сервисом оценки', 'Проверьте интернет-соединение сервера и повторите запрос.'],
    API_401: ['Нет доступа к сервису оценки', 'Проверьте ANTHROPIC_API_KEY в backend/.env и перезапустите сервер.'],
    API_403: ['Нет доступа к сервису оценки', 'Ключ API не имеет прав на эту модель. Проверьте настройки ключа.'],
    API_429: ['Сервис оценки перегружен', 'Слишком много запросов подряд. Повторите через минуту.'],
    API_5XX: ['Сервис оценки временно недоступен', 'Повторите запрос через минуту.'],
    HTTP_5XX: ['Сервер временно недоступен', 'Повторите запрос через минуту. Если ошибка повторяется — перезапустите сервер.'],
  };

  /** { title, message } для показа пользователю. Технические детали — в консоли. */
  function describeError(err, fallbackTitle) {
    const code = err && err.code;
    const entry =
      ERROR_TEXT[code] ||
      (/^API_5\d\d$/.test(code || '') ? ERROR_TEXT.API_5XX : /^HTTP_5\d\d$/.test(code || '') ? ERROR_TEXT.HTTP_5XX : null);
    if (entry) return { title: entry[0], message: entry[1], code };
    return { title: fallbackTitle || 'Не удалось выполнить действие', message: (err && err.message) || 'Попробуйте повторить запрос.', code };
  }

  /* =====================================================================
   * 3. Состояние и DOM-хелперы
   * ===================================================================== */

  const state = {
    groupId: CONFIG.groupId,
    list: [],          // краткие записи диалогов набора
    current: null,     // текущий диалог целиком
    checklists: [],    // сохранённые чек-листы
    checklist: null,   // редактируемая копия активного чек-листа
    dirty: false,      // есть несохранённые изменения чек-листа
    evaluations: [],
    evaluating: new Set(), // conversation_id, по которым идёт оценка
    evalErrors: new Map(), // conversation_id → { title, message } последней неудачной попытки
    appeals: [],
    mode: 'operator',  // 'operator' | 'reviewer' — симуляция ролей без авторизации
    ui: { appealFor: null, draft: '', decision: null }, // открытые формы в карточках результата
  };

  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));

  /** Создание элемента без innerHTML — тексты диалогов вставляются только как textContent. */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.setAttribute('style', v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function emptyState(icon, text) {
    return h('div', { class: 'empty' }, h('div', { class: 'empty__icon' }, icon), text);
  }

  /** Аккуратное состояние ошибки внутри блока (вместо пустого или «сломанного» блока). */
  function errorState(title, message, action) {
    return h('div', { class: 'empty empty--error', role: 'alert' },
      h('div', { class: 'empty__icon empty__icon--error', 'aria-hidden': 'true' }, '!'),
      h('div', { class: 'empty__title' }, title),
      message ? h('div', { class: 'small' }, message) : null,
      action ? h('button', { class: 'btn btn--outline btn--sm', type: 'button', onclick: action.onClick }, action.label) : null
    );
  }

  /* ---------- уведомления (toast) ---------- */

  const TOAST_ICON = { success: '✓', error: '!', warning: '!', info: 'i' };
  const TOAST_MS = { success: 4000, info: 5000, warning: 7000, error: 9000 };
  const visibleToasts = new Map(); // ключ → элемент: одинаковое уведомление не дублируется, а «подпрыгивает»

  /**
   * toast({ type: 'success'|'error'|'warning'|'info', title, message, action: { label, onClick } })
   * Автоматически скрывается (пауза при наведении), не больше 4 одновременно.
   */
  function toast({ type = 'info', title = '', message = '', action = null, duration } = {}) {
    const stack = $('#toasts');
    if (!stack) return;
    const key = `${type}|${title}|${message}`;
    const existing = visibleToasts.get(key);
    if (existing && existing.isConnected && !existing.classList.contains('is-leaving')) {
      // Такое же уведомление уже на экране (например, повтор не помог) — перезапускаем таймер и привлекаем внимание.
      const bar = existing.querySelector('.toast__timer');
      if (bar) {
        bar.style.animation = 'none';
        void bar.offsetWidth;
        bar.style.animation = '';
      }
      existing.classList.remove('is-bump');
      void existing.offsetWidth;
      existing.classList.add('is-bump');
      return;
    }

    const ms = duration || TOAST_MS[type] || 5000;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      visibleToasts.delete(key);
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 180);
    };
    const timerBar = h('div', { class: 'toast__timer', style: `animation-duration:${ms}ms`, 'aria-hidden': 'true' });
    timerBar.addEventListener('animationend', close);

    const el = h('div', { class: `toast toast--${type}`, role: type === 'error' || type === 'warning' ? 'alert' : 'status' },
      h('span', { class: 'toast__icon', 'aria-hidden': 'true' }, TOAST_ICON[type] || 'i'),
      h('div', { class: 'toast__body' },
        title ? h('div', { class: 'toast__title' }, title) : null,
        message ? h('div', { class: 'toast__msg' }, message) : null,
        action
          ? h('button', { class: 'toast__action', type: 'button', onclick: () => { close(); action.onClick(); } }, action.label)
          : null
      ),
      h('button', { class: 'toast__close', type: 'button', 'aria-label': 'Закрыть уведомление', onclick: close }, '×'),
      timerBar
    );
    stack.append(el);
    visibleToasts.set(key, el);
    while (stack.children.length > 4) stack.firstElementChild.remove();
  }

  /** Совместимость со старым API: короткое сообщение об успехе или ошибке. */
  function setStatus(text, isError) {
    if (!text) return;
    toast({ type: isError ? 'error' : 'success', message: text });
  }

  /** Уведомление об ошибке с понятным текстом по коду и, при необходимости, кнопкой «Повторить». */
  function notifyError(err, fallbackTitle, action) {
    console.error('[CQA]', fallbackTitle || '', err);
    const d = describeError(err, fallbackTitle);
    toast({ type: 'error', title: d.title, message: d.message, action });
    return d;
  }

  /* ---------- скелетные заглушки на время загрузки ---------- */

  const skel = (cls = '', style = null) => h('span', { class: `skel ${cls}`.trim(), style, 'aria-hidden': 'true' });

  const Skeleton = {
    evaluation(convId) {
      return h('div', { class: 'skel-wrap', 'aria-busy': 'true', 'aria-label': 'Идёт оценка диалога' },
        h('div', { class: 'skel-row' },
          skel('skel--circle'),
          h('div', { class: 'skel-col' }, skel('skel--line', 'width:55%'), skel('skel--line skel--sm', 'width:35%'), skel('skel--pill'))
        ),
        skel('skel--block', 'height:58px'),
        h('div', { class: 'skel-col' }, skel('skel--line skel--sm', 'width:100%'), skel('skel--line skel--sm', 'width:100%'), skel('skel--line skel--sm', 'width:100%')),
        ...[78, 64, 86, 70].map((w) =>
          h('div', { class: 'skel-card' },
            h('div', { class: 'skel-row skel-row--between' }, skel('skel--line', `width:${w / 2}%`), skel('skel--pill')),
            skel('skel--line skel--sm', `width:${w}%`),
            skel('skel--line skel--sm', `width:${w - 18}%`))
        ),
        h('div', { class: 'skel-caption' },
          'Модель анализирует диалог по чек-листу · ',
          h('span', { 'data-elapsed-for': convId }, elapsedText(convId)),
          ' · обычно 20–40 с')
      );
    },
    transcript() {
      return h('div', { class: 'skel-wrap skel-chat', 'aria-busy': 'true', 'aria-label': 'Загрузка диалога' },
        ...[['l', 62], ['l', 48], ['r', 70], ['l', 40], ['r', 56], ['l', 66]].map(([side, w]) =>
          h('div', { class: `skel-bubble skel-bubble--${side}`, style: `width:${w}%` },
            skel('skel--line skel--xs', 'width:35%'), skel('skel--line skel--sm', 'width:100%'), skel('skel--line skel--sm', 'width:72%')))
      );
    },
    kpis() {
      return [0, 1, 2].map(() =>
        h('div', { class: 'kpi kpi--skeleton', 'aria-hidden': 'true' },
          skel('skel--line skel--xs', 'width:55%'), skel('skel--line skel--lg', 'width:40%'), skel('skel--line skel--xs', 'width:80%')));
    },
    criteria() {
      return h('div', { class: 'skel-wrap', 'aria-busy': 'true', 'aria-label': 'Загрузка чек-листа' },
        ...[0, 1, 2, 3, 4].map(() =>
          h('div', { class: 'skel-card' },
            h('div', { class: 'skel-row' }, skel('skel--square'), skel('skel--line', 'width:60%')),
            h('div', { class: 'skel-row skel-row--indent' }, skel('skel--pill'), skel('skel--pill'), skel('skel--pill skel--wide')))));
    },
    rows(n = 3) {
      return h('div', { class: 'skel-wrap', 'aria-busy': 'true' },
        ...Array.from({ length: n }, () =>
          h('div', { class: 'skel-card' }, skel('skel--line', 'width:40%'), skel('skel--line skel--sm', 'width:85%'), skel('skel--line skel--xs', 'width:25%'))));
    },
  };

  /* ---------- таймер ожидания оценки ---------- */

  const evalStartedAt = new Map();
  let elapsedTicker = null;

  function elapsedText(convId) {
    const t = evalStartedAt.get(convId);
    return t ? `${Math.max(0, Math.round((Date.now() - t) / 1000))} с` : '0 с';
  }

  function tickElapsed() {
    $$('[data-elapsed-for]').forEach((el) => (el.textContent = elapsedText(el.dataset.elapsedFor)));
    const rec = state.current;
    if (rec && state.evaluating.has(rec.conversation_id)) {
      const label = $('#eval-btn .btn__label');
      if (label) label.textContent = `Оцениваем… ${elapsedText(rec.conversation_id)}`;
    }
    if (!state.evaluating.size) {
      clearInterval(elapsedTicker);
      elapsedTicker = null;
    }
  }

  const SPEAKER = { client: 'Клиент', operator: 'Оператор', bot: 'Бот', system: 'Система' };
  const CHANNEL = { 'agent chat': 'Чат', 'voice call': 'Звонок' };
  const LANG = { RU: 'Русский', KZ: 'Қазақша', EN: 'English' };
  const LANG_CODE = { RU: 'ru', KZ: 'kk', EN: 'en' };

  /* =====================================================================
   * 4. Роутинг по hash: ссылки-доказательства ведут прямо к реплике
   *    #/conversations/<id>/m/<index>   #/appeals
   * ===================================================================== */

  function msgLink(convId, idx) {
    return `#/conversations/${encodeURIComponent(convId)}/m/${idx}`;
  }

  function parseRoute() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    const view = parts[0] === 'appeals' ? 'appeals' : 'main';
    return { view, id: parts[0] === 'conversations' ? parts[1] || null : null, msg: parts[2] === 'm' ? Number(parts[3]) : null };
  }

  async function onRoute() {
    const r = parseRoute();
    $$('.cqa-view').forEach((v) => (v.hidden = v.dataset.view !== r.view));
    $$('.nav-link').forEach((t) => t.classList.toggle('is-active', t.dataset.view === r.view));

    if (r.view === 'main' && r.id) {
      if (!state.current || state.current.conversation_id !== r.id) await openConversation(r.id);
      if (r.msg != null) highlightMessage(r.msg);
    }
    if (r.view === 'appeals') renderAppeals();
  }

  /* =====================================================================
   * 5. Правая зона: выбор диалога
   * ===================================================================== */

  async function loadConversations() {
    const select = $('#conv-select');
    select.replaceChildren(h('option', { value: '', disabled: true, selected: true }, 'Загрузка диалогов…'));
    select.disabled = true;
    try {
      const data = await api.conversations(state.groupId);
      if (!Array.isArray(data.records)) throw new ApiError('Список диалогов пришёл не полностью', { code: 'BAD_RESPONSE' });
      state.list = data.records.filter((r) => r && typeof r.conversation_id === 'string');
    } catch (err) {
      state.list = [];
      notifyError(err, `Не удалось загрузить набор ${state.groupId}`, { label: 'Повторить', onClick: loadConversations });
    } finally {
      select.disabled = false;
      renderConvSelect();
    }
  }

  function evaluationFor(convId) {
    const cl = state.checklist;
    return state.evaluations.find(
      (e) => e.conversation_id === convId && e.group_id === state.groupId && (!cl || e.checklist_id === cl.id)
    );
  }

  function renderConvSelect() {
    const lang = $('#f-lang').value;
    const channel = $('#f-channel').value;
    const currentId = state.current && state.current.conversation_id;
    const items = state.list.filter(
      (c) => c.conversation_id === currentId || ((!lang || c.language === lang) && (!channel || c.channel === channel))
    );

    const groups = ['RU', 'KZ', 'EN']
      .map((code) => {
        const list = items.filter((c) => c.language === code);
        if (!list.length) return null;
        return h('optgroup', { label: `${LANG[code]} · ${list.length}` },
          list.map((c) => {
            const ev = evaluationFor(c.conversation_id);
            const preview = c.preview.length > 60 ? c.preview.slice(0, 60) + '…' : c.preview;
            const mark = ev ? ` — ✓ ${finalTotal(ev) ?? '—'}` : '';
            return h('option', { value: c.conversation_id, selected: c.conversation_id === currentId },
              `${c.conversation_id} · ${c.has_audio ? '🎧 ' : ''}${preview}${mark}`);
          })
        );
      })
      .filter(Boolean);

    const placeholder = h('option', { value: '', disabled: true, selected: !currentId },
      state.list.length ? 'Выберите диалог…' : 'Набор не загружен — нажмите «Обновить из API»');
    $('#conv-select').replaceChildren(placeholder, ...groups);

    const evaluated = state.list.filter((c) => evaluationFor(c.conversation_id)).length;
    $('#conv-count').textContent = state.list.length
      ? `Показано ${items.length} из ${state.list.length} · оценено ${evaluated}`
      : '';
    renderDashboard();
  }

  /* =====================================================================
   * 5a. Мини-дашборд руководителя
   *     Считается по оценённым диалогам текущего набора и чек-листа,
   *     с учётом решений проверяющего (финальные ответы).
   * ===================================================================== */

  function computeDashboard() {
    const cl = state.checklist;
    if (!cl) return null;
    const scores = state.list
      .map((c) => {
        const ev = evaluationFor(c.conversation_id);
        return ev ? { id: c.conversation_id, score: computeScore(cl, finalAnswers(ev)) } : null;
      })
      .filter(Boolean);

    const totals = scores.map((s) => s.score.total).filter((t) => typeof t === 'number');
    const avg = totals.length ? roundTo(totals.reduce((a, b) => a + b, 0) / totals.length, 2) : null;
    const critical = scores.filter((s) => s.score.has_critical).map((s) => s.id);

    // Потерянные баллы по критерию: эффективный вес (после перераспределения N/A) минус набранные баллы.
    const loss = {};
    for (const { score } of scores) {
      for (const r of score.rows) {
        if (r.kind !== 'scored') continue;
        const lost = r.effective_weight - r.points;
        const acc = (loss[r.id] = loss[r.id] || { lost: 0, dialogs: 0, applicable: 0 });
        acc.applicable += 1;
        if (lost > 0.005) {
          acc.lost += lost;
          acc.dialogs += 1;
        }
      }
    }
    const ranked = Object.entries(loss)
      .filter(([, v]) => v.lost > 0)
      .sort(([, a], [, b]) => b.lost - a.lost || b.dialogs - a.dialogs);
    const top = ranked.length
      ? (() => {
          const [id, v] = ranked[0];
          const c = cl.criteria.find((x) => x.id === id);
          return { id, title: c ? c.title : id, avgLost: roundTo(v.lost / scores.length, 2), dialogs: v.dialogs, applicable: v.applicable };
        })()
      : null;

    return {
      evaluated: scores.length,
      total: state.list.length,
      avg,
      min: totals.length ? Math.min(...totals) : null,
      max: totals.length ? Math.max(...totals) : null,
      critical,
      top,
      runnerUp: ranked[1] ? (cl.criteria.find((x) => x.id === ranked[1][0]) || {}).title : null,
    };
  }

  function renderDashboard() {
    const bar = $('#kpi-bar');
    const d = computeDashboard();
    if (!d || !d.evaluated) {
      return bar.replaceChildren(
        h('div', { class: 'kpi kpi--empty' },
          h('span', { class: 'kpi__icon', 'aria-hidden': 'true' }, '📊'),
          h('div', null,
            h('div', { class: 'kpi__label' }, 'Аналитика по операторам'),
            h('div', { class: 'kpi__sub' }, 'Оцените первый диалог — здесь появятся средний балл, грубые ошибки и слабое место команды.')))
      );
    }

    const tone = d.avg == null ? '' : d.avg < 60 ? ' kpi__fill--low' : d.avg < 85 ? ' kpi__fill--mid' : '';
    const avgTile = h('div', { class: 'kpi' },
      h('div', { class: 'kpi__label' }, 'Средний балл операторов'),
      h('div', { class: 'kpi__value' }, d.avg == null ? '—' : d.avg, h('span', { class: 'kpi__unit' }, ' / 100')),
      h('div', { class: 'kpi__track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(d.avg ?? 0) },
        h('div', { class: `kpi__fill${tone}`, style: `width:${d.avg ?? 0}%` })),
      h('div', { class: 'kpi__sub' },
        `по ${d.evaluated} из ${d.total} диалогов`, d.min != null && d.evaluated > 1 ? ` · мин ${d.min} · макс ${d.max}` : '')
    );

    const hasCritical = d.critical.length > 0;
    const critTile = h(hasCritical ? 'button' : 'div', {
      class: `kpi${hasCritical ? ' kpi--danger' : ' kpi--ok'}`,
      type: hasCritical ? 'button' : null,
      title: hasCritical ? `Диалоги с грубыми ошибками: ${d.critical.join(', ')}. Нажмите, чтобы открыть.` : null,
      onclick: hasCritical
        ? () => {
            const i = d.critical.indexOf(state.current && state.current.conversation_id);
            const next = d.critical[(i + 1) % d.critical.length];
            location.hash = `#/conversations/${encodeURIComponent(next)}`;
          }
        : null,
    },
      h('div', { class: 'kpi__label' }, 'Выявлено грубых ошибок'),
      h('div', { class: 'kpi__value' }, hasCritical ? h('span', { class: 'kpi__badge' }, d.critical.length) : '0'),
      h('div', { class: 'kpi__sub' }, hasCritical
        ? `в ${d.critical.length} из ${d.evaluated} диалогов · открыть →`
        : 'оскорблений, услуг в обход компании и утечек данных нет')
    );

    const topTile = h('div', { class: 'kpi' },
      h('div', { class: 'kpi__label' }, 'Чаще всего теряют баллы'),
      d.top
        ? [
            h('div', { class: 'kpi__value kpi__value--text', title: d.top.title }, d.top.title),
            h('div', { class: 'kpi__sub' },
              `−${d.top.avgLost} б. на диалог · не выполнено в ${d.top.dialogs} из ${d.top.applicable}`,
              d.runnerUp ? ` · далее: ${d.runnerUp}` : ''),
          ]
        : [h('div', { class: 'kpi__value kpi__value--text' }, 'Потерь нет'), h('div', { class: 'kpi__sub' }, 'все применимые критерии выполнены')]
    );

    bar.replaceChildren(avgTile, critTile, topTile);
  }

  async function openConversation(id) {
    // Скелет показываем, только если загрузка заметна (> 150 мс), чтобы не мигать на быстром ответе.
    const skeletonTimer = setTimeout(() => {
      $('#conv-card').replaceChildren(Skeleton.transcript());
      if (!state.current || state.current.conversation_id !== id) $('#eval-panel').replaceChildren(Skeleton.rows(4));
    }, 150);
    try {
      const rec = await api.conversation(state.groupId, id);
      if (!rec || !Array.isArray(rec.transcript)) throw new ApiError('Диалог пришёл не полностью', { code: 'BAD_RESPONSE' });
      state.current = rec;
    } catch (err) {
      clearTimeout(skeletonTimer);
      const retry = { label: 'Повторить', onClick: () => openConversation(id).then(() => {
        if (state.current && state.current.conversation_id === id) history.replaceState(null, '', `#/conversations/${encodeURIComponent(id)}`);
      }) };
      const d = notifyError(err, `Не удалось открыть диалог ${id}`, retry);
      if (state.current && state.current.conversation_id !== id) {
        // Остаёмся на открытом диалоге: возвращаем его отображение и адрес, чтобы шапка и транскрипт совпадали.
        history.replaceState(null, '', `#/conversations/${encodeURIComponent(state.current.conversation_id)}`);
        renderConvSelect();
        renderTranscript();
        renderEvalPanel();
      } else if (!state.current) {
        $('#conv-card').replaceChildren(errorState(d.title, d.message, retry));
      }
      return;
    }
    clearTimeout(skeletonTimer);
    renderConvSelect();
    renderConvMeta();
    renderPlayer(); // плеер — только для звонков; для чата скрывается
    renderTranscript();
    renderEvalPanel();
  }

  function renderConvMeta() {
    const rec = state.current;
    if (!rec) return $('#conv-meta').replaceChildren();
    const operatorReplies = rec.transcript.filter((m) => m.speaker === 'operator').length;
    $('#conv-meta').replaceChildren(
      h('span', { class: 'pill pill--dark' }, rec.conversation_id),
      h('span', { class: 'pill' }, CHANNEL[rec.channel] || rec.channel),
      h('span', { class: 'pill' }, LANG[rec.language] || rec.language),
      h('span', { class: 'pill' }, `${rec.transcript.length} реплик · ${operatorReplies} от оператора`)
    );
  }

  /* =====================================================================
   * 6. Правая зона: запись звонка + транскрипт
   * ===================================================================== */

  const isIsoTime = (t) => /^\d{4}-\d{2}-\d{2}T/.test(t);
  function fmtOffset(sec) {
    const s = Math.max(0, Math.floor(sec));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  const isCall = (rec) => Boolean(rec && rec.channel === 'voice call');

  /**
   * Смещение каждой реплики от начала разговора, в секундах (null — время не распознано).
   * У звонков timestamp — ISO 8601 с часовым поясом; начало — время первой реплики транскрипта.
   */
  function turnOffsets(rec) {
    const first = rec.transcript.find((m) => isIsoTime(m.timestamp));
    const t0 = first ? Date.parse(first.timestamp) : null;
    return rec.transcript.map((m) => (t0 != null && isIsoTime(m.timestamp) ? Math.max(0, (Date.parse(m.timestamp) - t0) / 1000) : null));
  }

  /* ---------- плеер записи звонка ---------- */

  const SPEEDS = [1, 1.25, 1.5, 2];
  const WAVE_BARS = 96;
  const player = {
    convId: null,
    offsets: [],      // смещение каждой реплики, с
    span: 0,          // длительность по транскрипту, с (пока запись не загружена или её нет)
    available: false, // есть ли audio_url
    pendingSeek: null,
    virtualTime: 0,   // позиция на шкале, если записи нет
    playingTurn: null,
    speed: 1,
  };

  const audioEl = () => $('#call-audio');
  const audioDuration = () => {
    const d = audioEl().duration;
    return Number.isFinite(d) && d > 0 ? d : null;
  };
  const timelineLength = () => audioDuration() || Math.max(player.span, 1);

  /**
   * «Звуковая волна» по транскрипту: высота столбика — сколько сказано в этот момент
   * (длина реплики, распределённая до следующей реплики), цвет — кто говорил.
   */
  function buildWave(rec, offsets, span) {
    const buckets = Array.from({ length: WAVE_BARS }, () => ({ amount: 0, by: {} }));
    rec.transcript.forEach((m, i) => {
      const start = offsets[i];
      if (start == null || m.speaker === 'system') return;
      const next = offsets.slice(i + 1).find((x) => x != null && x > start);
      const end = Math.min(next ?? start + 4, start + 30); // реплика «звучит» до следующей, но не дольше 30 с
      const b0 = Math.min(WAVE_BARS - 1, Math.floor((start / span) * WAVE_BARS));
      const b1 = Math.max(b0, Math.min(WAVE_BARS - 1, Math.floor((end / span) * WAVE_BARS)));
      const per = (m.text || '').length / (b1 - b0 + 1);
      for (let b = b0; b <= b1; b++) {
        buckets[b].amount += per;
        buckets[b].by[m.speaker] = (buckets[b].by[m.speaker] || 0) + per;
      }
    });
    const max = Math.max(1, ...buckets.map((b) => b.amount));
    return buckets.map((b) => ({
      height: b.amount ? 22 + (b.amount / max) * 78 : 10,
      who: Object.entries(b.by).sort((x, y) => y[1] - x[1])[0]?.[0] || 'silence',
    }));
  }

  function drawWave(span) {
    const bars = buildWave(state.current, player.offsets, span);
    const row = () => h('div', { class: 'wave__bars' },
      bars.map((b) => h('span', { class: `wave__bar wave__bar--${b.who}`, style: `height:${b.height.toFixed(1)}%` })));
    $('#player-wave').replaceChildren(
      row(),
      h('div', { class: 'wave__played', 'aria-hidden': 'true' }, row()),
      h('span', { class: 'wave__head', 'aria-hidden': 'true' })
    );
  }

  function setPlayingIcon(playing) {
    const btn = $('#player-toggle');
    btn.classList.toggle('is-playing', playing);
    btn.setAttribute('aria-label', playing ? 'Пауза' : 'Воспроизвести запись');
  }

  function updatePlayerUI(t) {
    const len = timelineLength();
    const pct = Math.min(100, Math.max(0, (t / len) * 100));
    const wave = $('#player-wave');
    wave.style.setProperty('--progress', `${pct}%`);
    wave.setAttribute('aria-valuemax', String(Math.round(len)));
    wave.setAttribute('aria-valuenow', String(Math.round(t)));
    wave.setAttribute('aria-valuetext', `${fmtOffset(t)} из ${fmtOffset(len)}`);
    $('#player-current').textContent = fmtOffset(t);
    $('#player-duration').textContent = audioDuration() ? fmtOffset(audioDuration()) : `≈${fmtOffset(player.span)}`;
    markPlayingTurn(t);
  }

  /** Во время прослушивания отмечаем в транскрипте реплику, которая сейчас звучит. */
  function markPlayingTurn(t) {
    const audio = audioEl();
    const active = player.available ? !audio.paused || t > 0 : t > 0;
    let turn = null;
    if (active) player.offsets.forEach((o, i) => { if (o != null && o <= t + 0.25) turn = i + 1; });
    if (turn === player.playingTurn) return;
    $$('.msg.is-playing').forEach((m) => m.classList.remove('is-playing'));
    player.playingTurn = turn;
    if (turn) {
      const el = document.getElementById(`msg-${turn}`);
      if (el) el.classList.add('is-playing');
    }
  }

  /**
   * Показывает плеер для звонка (channel = "voice call") и скрывает для чата.
   * Источник — audio_url. Ссылка из audio_url открывает HTML-страницу плеера организаторов,
   * поэтому <audio> получает её через сервер (/api/audio/:id): сервер достаёт из страницы mp3.
   * Если audio_url = null — вместо записи только шкала активности речи по транскрипту.
   */
  function renderPlayer() {
    const rec = state.current;
    const box = $('#call-player');
    const audio = audioEl();
    if (!isCall(rec)) {
      box.hidden = true;
      if (player.convId) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
      Object.assign(player, { convId: null, offsets: [], span: 0, available: false, pendingSeek: null, virtualTime: 0, playingTurn: null });
      return;
    }
    if (player.convId === rec.conversation_id) return; // тот же звонок — позицию не сбрасываем

    player.convId = rec.conversation_id;
    player.offsets = turnOffsets(rec);
    const known = player.offsets.filter((x) => x != null);
    player.span = (known.length ? Math.max(...known) : 0) + 5;
    player.available = Boolean(rec.audio_url);
    player.pendingSeek = null;
    player.virtualTime = 0;
    player.playingTurn = null;

    box.hidden = false;
    box.classList.toggle('is-unavailable', !player.available);
    audio.pause();
    if (player.available) {
      audio.src = api.audioUrl(state.groupId, rec.conversation_id);
      audio.load();
      audio.playbackRate = player.speed;
    } else {
      audio.removeAttribute('src');
      audio.load();
    }
    const ext = $('#player-external');
    ext.hidden = !rec.audio_url;
    if (rec.audio_url) ext.href = rec.audio_url;
    $('#player-toggle').disabled = !player.available;
    $('#player-speed').disabled = !player.available;
    $('#player-status').textContent = player.available
      ? 'Загрузка записи…'
      : 'Аудиозапись недоступна (audio_url = null) — шкала показывает активность речи по транскрипту.';
    setPlayingIcon(false);
    drawWave(player.span);
    updatePlayerUI(0);
  }

  /**
   * Перемотка записи звонка на `seconds` от начала разговора.
   * Если запись ещё не загрузилась — перемотка выполнится, как только станут известны метаданные.
   * Без записи (audio_url = null) двигается только отметка на шкале. Для чатов ничего не делает.
   */
  function seekToTime(seconds, { play = false } = {}) {
    if (!isCall(state.current) || !Number.isFinite(seconds)) return false;
    const audio = audioEl();
    const t = Math.max(0, Math.min(seconds, timelineLength()));
    if (player.available) {
      if (audio.readyState >= 1) audio.currentTime = t; // HAVE_METADATA
      else player.pendingSeek = t;
      if (play) {
        audio.play().catch((err) => {
          if (err && err.name !== 'AbortError') toast({ type: 'warning', title: 'Не удалось воспроизвести запись', message: 'Откройте плеер организаторов по кнопке ↗.' });
        });
      }
    } else {
      player.virtualTime = t;
    }
    updatePlayerUI(t);
    const box = $('#call-player');
    box.classList.remove('is-seeking');
    void box.offsetWidth;
    box.classList.add('is-seeking');
    return true;
  }

  /** Перемотка к реплике по её номеру turn (с 1, как в evidence_turns). */
  function seekToTurn(turn, opts) {
    const offset = player.offsets[turn - 1];
    return offset == null ? false : seekToTime(offset, opts);
  }

  function bindPlayer() {
    const audio = audioEl();
    const box = $('#call-player');
    const wave = $('#player-wave');

    audio.addEventListener('loadedmetadata', () => {
      $('#player-status').textContent = '';
      // Шкалу строим по реальной длительности записи, если она известна.
      if (audioDuration() && Math.abs(audioDuration() - player.span) > 2) drawWave(audioDuration());
      if (player.pendingSeek != null) {
        audio.currentTime = player.pendingSeek;
        player.pendingSeek = null;
      }
      updatePlayerUI(audio.currentTime);
    });
    audio.addEventListener('timeupdate', () => updatePlayerUI(audio.currentTime));
    audio.addEventListener('play', () => setPlayingIcon(true));
    audio.addEventListener('pause', () => setPlayingIcon(false));
    audio.addEventListener('ended', () => setPlayingIcon(false));
    audio.addEventListener('error', () => {
      if (!player.convId || !audio.getAttribute('src')) return;
      box.classList.add('is-unavailable');
      $('#player-toggle').disabled = true;
      $('#player-status').textContent = 'Запись не загрузилась — шкала работает по транскрипту. Можно открыть плеер организаторов (↗).';
      player.available = false;
    });

    $('#player-toggle').addEventListener('click', () => {
      if (!player.available) return;
      if (audio.paused) seekToTime(audio.currentTime, { play: true });
      else audio.pause();
    });
    $('#player-speed').addEventListener('click', () => {
      player.speed = SPEEDS[(SPEEDS.indexOf(player.speed) + 1) % SPEEDS.length];
      audio.playbackRate = player.speed;
      $('#player-speed').textContent = `${player.speed}×`;
    });

    const currentTime = () => (player.available ? audio.currentTime : player.virtualTime);
    wave.addEventListener('click', (e) => {
      const rect = wave.getBoundingClientRect();
      const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      seekToTime(pct * timelineLength(), { play: player.available && !audio.paused });
    });
    wave.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: -5, ArrowRight: 5, PageDown: -30, PageUp: 30 }[e.key];
      if (step) seekToTime(currentTime() + step, { play: player.available && !audio.paused });
      else if (e.key === 'Home') seekToTime(0);
      else if (e.key === 'End') seekToTime(timelineLength());
      else if (e.key === ' ' || e.key === 'Enter') $('#player-toggle').click();
      else return;
      e.preventDefault();
    });
  }

  /* ---------- транскрипт ---------- */

  function renderTranscript() {
    const rec = state.current;
    const box = $('#conv-card');
    // Для звонков время реплики — смещение от начала разговора; по нему перематывается запись.
    // Исходная метка сохраняется и показывается во всплывающей подсказке.
    const offsets = isCall(rec) ? turnOffsets(rec) : [];

    // lang — для правильных переносов длинных слов (казахский, английский, русский).
    const transcript = h('div', { class: 'transcript', lang: LANG_CODE[rec.language] || null },
      rec.transcript.map((m, i) => {
        // Номер реплики (turn) — с 1 по всему транскрипту, как в формате JSON 1.0 и в обоснованиях модели.
        const turn = i + 1;
        let time;
        if (offsets[i] != null) {
          time = h('button', {
            class: 'msg__time', type: 'button', title: `${m.timestamp} — перейти к этому моменту записи`,
            onclick: () => seekToTurn(turn, { play: true }),
          }, `▶ ${fmtOffset(offsets[i])}`);
        } else {
          time = h('span', { class: 'msg__time', title: m.timestamp }, m.timestamp);
        }
        return h('div', { class: `msg msg--${m.speaker}`, id: `msg-${turn}` },
          h('div', { class: 'msg__meta' },
            h('a', { class: 'msg__speaker', href: msgLink(rec.conversation_id, turn), title: 'Ссылка на реплику' }, `#${turn} ${SPEAKER[m.speaker] || m.speaker}`),
            time
          ),
          h('div', { class: 'msg__text' }, m.text)
        );
      })
    );

    box.replaceChildren(transcript);
    box.scrollTop = 0;
    player.playingTurn = null; // отметка «звучит сейчас» восстановится при следующем timeupdate
  }

  /**
   * Подсветка реплики по номеру turn (с 1) — из ссылки-доказательства, обоснования или адреса.
   * Для звонка запись дополнительно перематывается к этой реплике (воспроизведение не запускается,
   * но если запись уже играет — продолжит с нового места).
   */
  function highlightMessage(turn) {
    $$('.msg.is-highlight').forEach((m) => m.classList.remove('is-highlight'));
    const el = document.getElementById(`msg-${turn}`);
    if (!el) return;
    void el.offsetWidth; // перезапуск анимации при повторном клике
    el.classList.add('is-highlight');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (isCall(state.current)) seekToTurn(turn, { play: !audioEl().paused });
  }

  /* =====================================================================
   * 7. Правая зона: кнопка «Оценить оператора» и результат
   *    Формат сохранённой оценки (коллекция evaluations):
   *    { id, group_id, conversation_id, checklist_id, checklist_version, summary, model, cost,
   *      answers: { [criterionId]: { value, explanation, quote, evidence: [msgIdx], checked_range: [from, to] } } }
   * ===================================================================== */

  function renderEvalButton() {
    const btn = $('#eval-btn');
    const rec = state.current;
    const busy = Boolean(rec && state.evaluating.has(rec.conversation_id));
    const ev = rec && evaluationFor(rec.conversation_id);
    btn.disabled = !rec || busy;
    btn.classList.toggle('is-busy', busy);
    btn.setAttribute('aria-busy', String(busy));
    $('.btn__label', btn).textContent = busy
      ? `Оцениваем… ${elapsedText(rec.conversation_id)}`
      : ev ? 'Переоценить оператора' : 'Оценить оператора';
  }

  /** Подпись ответа: true → «Да», false → «Нет», null/'NA' → «N/A», число → «7 / 10». */
  function answerLabel(c, value) {
    value = normValue(value);
    if (value === NA) return 'N/A';
    if (value === undefined) return '—';
    if (c.type === 'scale') return `${value} / ${scaleMax(c)}`;
    if (value === true) return 'Да';
    if (value === false) return 'Нет';
    return String(value); // неожиданный тип — показываем как есть, а не подменяем «Да»/«Нет»
  }

  function answerTone(c, value) {
    value = normValue(value);
    if (value === NA) return 'na';
    if (value === undefined) return '';
    if (c.type === 'critical') return value ? 'no' : 'yes'; // «Да» в грубых ошибках — плохо
    if (c.type === 'scale') {
      const r = Number(value) / scaleMax(c);
      return r >= 1 ? 'yes' : r > 0 ? 'partial' : 'no';
    }
    return value ? 'yes' : 'no';
  }

  const TONE_PILL = { yes: 'pill--ok', no: 'pill--bad', partial: 'pill--warn', na: '' };

  /** Переход к реплике-доказательству: подсветка в окне чата (повторный клик по той же ссылке тоже работает). */
  function goToMessage(convId, idx) {
    const link = msgLink(convId, idx);
    if (location.hash === link) highlightMessage(idx);
    else location.hash = link;
  }

  /** Делает элемент кликабельным: клик/Enter ведёт к первой реплике-доказательству. */
  function evidenceTarget(convId, evidence) {
    if (!evidence || !evidence.length) return {};
    const go = () => goToMessage(convId, evidence[0]);
    return {
      role: 'button',
      tabindex: '0',
      title: `Показать реплику #${evidence[0]} в чате`,
      onclick: go,
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          go();
        }
      },
    };
  }

  function renderEvalPanel() {
    renderEvalButton();
    const panel = $('#eval-panel');
    const rec = state.current;
    const cl = state.checklist;
    if (!rec || !cl) return;

    // Идёт оценка — скелет результата вместо спиннера.
    if (state.evaluating.has(rec.conversation_id)) {
      return panel.replaceChildren(Skeleton.evaluation(rec.conversation_id));
    }

    const ev = evaluationFor(rec.conversation_id);
    const lastError = state.evalErrors.get(rec.conversation_id);
    const retry = { label: 'Повторить оценку', onClick: () => runEvaluation(rec.conversation_id) };

    if (!ev) {
      return panel.replaceChildren(
        lastError
          ? errorState(lastError.title, lastError.message, retry)
          : emptyState('📋', [
              h('div', null, `Диалог ещё не оценён по чек-листу «${cl.name}».`),
              h('div', { class: 'small' }, 'Нажмите «Оценить оператора» — модель проставит ответы, баллы и реплики-доказательства.'),
            ])
      );
    }
    if (!ev.answers || typeof ev.answers !== 'object') {
      return panel.replaceChildren(errorState(NOT_CONFIDENT, 'Сохранённая оценка неполная. Повторите оценку диалога.', retry));
    }

    const keepScroll = panel.scrollTop;
    const original = computeScore(cl, ev.answers || {});
    const score = computeScore(cl, finalAnswers(ev));
    const rowById = Object.fromEntries(score.rows.map((r) => [r.id, r]));
    const appeals = appealsFor(ev);
    const changedCount = appeals.filter((a) => a.status === 'changed').length;
    const openCount = appeals.filter((a) => a.status === 'open').length;
    const pct = score.total == null ? 0 : score.total;
    const naCount = score.rows.filter((r) => r.kind === 'na').length;

    const head = h('div', { class: 'score-head' },
      h('div', {
        class: 'score-ring' + (pct < 60 ? ' score-ring--low' : pct < 85 ? ' score-ring--mid' : ''),
        style: `--p:${pct}`,
      },
        h('div', { class: 'score-ring__inner' },
          h('span', { class: 'score-ring__value' }, score.total == null ? '—' : score.total),
          h('span', { class: 'score-ring__max' }, 'из 100')
        )
      ),
      h('div', { class: 'score-head__info' },
        h('span', { class: 'score-head__title' }, changedCount ? 'Финальный результат' : `${cl.name} · v${ev.checklist_version}`),
        changedCount
          ? h('div', { class: 'score-diff' },
              h('span', { class: 'score-diff__old' }, `Исходная оценка ${original.total ?? '—'}`),
              h('span', { class: 'score-diff__arrow', 'aria-hidden': 'true' }, '→'),
              h('span', { class: 'score-diff__new' }, `после пересмотра ${score.total ?? '—'}`))
          : null,
        h('div', { class: 'score-head__badges' },
          score.has_critical
            ? h('span', { class: 'pill pill--bad' }, '⚠ Грубая ошибка')
            : h('span', { class: 'pill pill--ok' }, 'Грубых ошибок нет'),
          naCount ? h('span', { class: 'pill' }, `N/A: ${naCount}`) : null,
          openCount ? h('span', { class: 'pill pill--warn' }, `Апелляций на рассмотрении: ${openCount}`) : null,
          changedCount ? h('span', { class: 'pill pill--dark' }, `Изменено проверяющим: ${changedCount}`) : null,
          !score.complete ? h('span', { class: 'pill pill--warn' }, 'Неполная оценка') : null,
          ev.checklist_version !== cl.version ? h('span', { class: 'pill pill--warn' }, 'Чек-лист изменён — переоцените') : null
        )
      )
    );

    const summary = ev.summary ? h('p', { class: 'eval-summary' }, ev.summary) : null;
    const meta = ev.cost && typeof ev.cost.usd === 'number'
      ? h('div', { class: 'eval-meta' },
          `${ev.model} · $${ev.cost.usd.toFixed(4)} · ${ev.duration_sec} с · токены: вход ${ev.cost.input_tokens + ev.cost.cache_write_tokens + ev.cost.cache_read_tokens}, выход ${ev.cost.output_tokens}`,
          ev.updated_at ? ` · ${new Date(ev.updated_at).toLocaleString()}` : '')
      : null;

    const sectionBars = h('div', { class: 'sections' },
      score.sections.filter((s) => s.points != null).map((s) =>
        h('div', null,
          h('div', { class: 'section-bar__row' }, h('span', null, s.title), h('span', null, `${s.points} / ${s.max}`)),
          h('div', { class: 'section-bar__track' },
            h('div', { class: 'section-bar__fill', style: `width:${s.max ? (s.points / s.max) * 100 : 0}%` }))
        )
      )
    );

    const sections = cl.sections.map((s) => {
      const crit = cl.criteria.filter((c) => c.section === s.id);
      if (!crit.length) return null;
      return h('div', { class: 'eval-section' },
        h('div', { class: 'eval-section__title' }, s.title),
        crit.map((c) => renderCriterionCard(rec, ev, c, rowById[c.id]))
      );
    });

    // Повторная оценка не удалась — показываем предыдущий результат и предупреждение над ним.
    const notice = lastError
      ? h('div', { class: 'inline-alert', role: 'alert' },
          h('div', null,
            h('strong', null, `${lastError.title}. `),
            'Показан предыдущий результат оценки.'),
          h('button', { class: 'btn btn--outline btn--sm', type: 'button', onclick: retry.onClick }, 'Повторить'))
      : null;

    panel.replaceChildren(...[notice, head, summary, meta, sectionBars, ...sections].filter(Boolean));
    panel.scrollTop = keepScroll;
  }

  /** Карточка критерия: ответ, баллы, обоснование (кликабельно), апелляция и решение проверяющего. */
  function renderCriterionCard(rec, ev, c, row) {
    const orig = (ev.answers || {})[c.id] || {};
    const appeal = appealFor(ev, c.id);
    const changed = appeal && appeal.status === 'changed';
    const value = changed ? appeal.decision.value : orig.value;
    const tone = answerTone(c, value);
    const evidence = orig.evidence || [];
    const convId = rec.conversation_id;

    const points =
      c.type === 'critical' ? 'без баллов'
      : row && row.kind === 'na' ? `вес ${c.weight} перераспределён`
      : row && row.points != null ? `${roundTo(row.points, 2)} из ${roundTo(row.effective_weight, 2)} · вес ${c.weight}`
      : `вес ${c.weight}`;

    const links = evidence.map((i) =>
      h('a', {
        href: msgLink(convId, i),
        title: 'Перейти к реплике',
        onclick: (e) => {
          e.preventDefault();
          goToMessage(convId, i);
        },
      }, `#${i}`)
    );

    return h('div', { class: `eval-crit eval-crit--${tone || 'na'}${appeal ? ' eval-crit--disputed' : ''}`, 'data-criterion': c.id },
      h('div', { class: 'eval-crit__head' },
        h('span', { class: 'eval-crit__name' }, c.title),
        h('span', { class: 'eval-crit__score' },
          h('span', { class: 'eval-crit__points' }, points),
          changed ? h('span', { class: 'pill pill--struck', title: 'Исходная оценка модели' }, answerLabel(c, orig.value)) : null,
          h('span', { class: `pill ${TONE_PILL[tone] || ''}` }, answerLabel(c, value))
        )
      ),
      h('div', { class: 'eval-crit__body' },
        orig.explanation ? h('div', { class: 'eval-explain', ...evidenceTarget(convId, evidence) }, orig.explanation) : null,
        orig.quote ? h('blockquote', { class: 'eval-quote', lang: LANG_CODE[rec.language] || null, ...evidenceTarget(convId, evidence) }, orig.quote) : null,
        links.length || orig.checked_range
          ? h('div', { class: 'eval-links' },
              links.length ? ['Основание: ', ...links] : null,
              orig.checked_range
                ? [' Проверенный участок: ', h('a', {
                    href: msgLink(convId, orig.checked_range[0]),
                    onclick: (e) => {
                      e.preventDefault();
                      goToMessage(convId, orig.checked_range[0]);
                    },
                  }, `#${orig.checked_range[0]}–#${orig.checked_range[1]}`)]
                : null)
          : null,
        orig.value !== undefined ? renderAppealArea(rec, ev, c, appeal) : null
      )
    );
  }

  /* ---------- апелляция и решение внутри карточки ---------- */

  const APPEAL_STATUS = {
    open: ['На рассмотрении', 'pill--warn'],
    confirmed: ['Оценка подтверждена', 'pill--ok'],
    changed: ['Оценка изменена', 'pill--dark'],
  };

  function renderAppealArea(rec, ev, c, appeal) {
    const reviewer = state.mode === 'reviewer';

    // Нет апелляции: оператор может оспорить, проверяющему здесь делать нечего.
    if (!appeal) {
      if (reviewer) return null;
      if (state.ui.appealFor !== c.id) {
        return h('button', {
          class: 'btn btn--outline btn--sm',
          type: 'button',
          onclick: () => {
            state.ui.appealFor = c.id;
            state.ui.draft = '';
            renderEvalPanel();
            focusField(`[data-criterion="${c.id}"] textarea`);
          },
        }, 'Оспорить');
      }
      const textarea = h('textarea', {
        class: 'input', rows: '3', placeholder: 'Почему вы не согласны с оценкой? Сошлитесь на реплики, например #9.',
        oninput: (e) => (state.ui.draft = e.target.value),
      });
      textarea.value = state.ui.draft || '';
      return h('div', { class: 'inline-form' },
        h('label', { class: 'inline-form__label' }, `Апелляция по критерию «${c.title}»`),
        textarea,
        h('div', { class: 'inline-form__actions' },
          h('button', { class: 'btn btn--dark btn--sm', type: 'button', onclick: () => submitAppeal(ev, c, textarea.value) }, 'Сохранить апелляцию'),
          h('button', { class: 'btn btn--text btn--sm', type: 'button', onclick: () => closeForms() }, 'Отмена')
        )
      );
    }

    // Есть апелляция: проверяющий видит спорную оценку, комментарий и фрагмент диалога.
    const [label, cls] = APPEAL_STATUS[appeal.status] || [appeal.status, ''];
    const origValue = appeal.original_answer ? normValue(appeal.original_answer.value) : undefined;
    const fragment = (appeal.original_answer?.evidence || [])
      .slice(0, 3)
      .map((turn) => {
        const m = rec.transcript[turn - 1]; // turn — с 1
        return m && h('div', { class: 'fragment__msg', ...evidenceTarget(rec.conversation_id, [turn]) },
          h('span', { class: 'fragment__who' }, `#${turn} ${SPEAKER[m.speaker] || m.speaker}: `),
          m.text);
      })
      .filter(Boolean);

    const box = h('div', { class: `appeal-box appeal-box--${appeal.status}` },
      h('div', { class: 'appeal-box__head' },
        h('span', { class: 'appeal-box__title' }, 'Апелляция'),
        h('span', { class: `pill ${cls}` }, label),
        h('span', { class: 'appeal-box__date' }, new Date(appeal.created_at).toLocaleString())
      ),
      h('div', { class: 'appeal-box__row' }, h('span', { class: 'appeal-box__key' }, 'Спорная оценка'), answerLabel(c, origValue)),
      h('div', { class: 'appeal-box__row' }, h('span', { class: 'appeal-box__key' }, 'Комментарий оператора'), appeal.comment),
      reviewer && fragment.length
        ? h('div', { class: 'fragment' }, h('span', { class: 'appeal-box__key' }, 'Фрагмент диалога'), ...fragment)
        : null,
      appeal.decision
        ? h('div', { class: 'decision' },
            h('div', { class: 'appeal-box__row' },
              h('span', { class: 'appeal-box__key' }, 'Решение проверяющего'),
              appeal.status === 'changed'
                ? `оценка изменена: ${answerLabel(c, origValue)} → ${answerLabel(c, appeal.decision.value)}`
                : `оценка подтверждена (${answerLabel(c, origValue)})`),
            h('div', { class: 'appeal-box__row' }, h('span', { class: 'appeal-box__key' }, 'Причина'), appeal.decision.reason),
            appeal.decision.total_before != null
              ? h('div', { class: 'appeal-box__row' }, h('span', { class: 'appeal-box__key' }, 'Итог'),
                  `${appeal.decision.total_before} → ${appeal.decision.total_after}`)
              : null)
        : null
    );

    if (reviewer) box.append(renderDecisionControls(ev, c, appeal));
    return box;
  }

  function renderDecisionControls(ev, c, appeal) {
    const form = state.ui.decision && state.ui.decision.criterionId === c.id ? state.ui.decision : null;
    if (!form) {
      const again = appeal.status !== 'open';
      return h('div', { class: 'inline-form__actions' },
        h('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => openDecision(c, 'confirm') },
          again ? 'Подтвердить исходную' : 'Подтвердить оценку'),
        h('button', { class: 'btn btn--dark btn--sm', type: 'button', onclick: () => openDecision(c, 'change') },
          again ? 'Изменить решение' : 'Изменить оценку')
      );
    }

    const origValue = appeal.original_answer ? normValue(appeal.original_answer.value) : undefined;
    const children = [h('label', { class: 'inline-form__label' }, form.kind === 'confirm' ? 'Подтвердить оценку' : 'Изменить оценку')];
    let select = null;
    let preview = null;

    if (form.kind === 'change') {
      const options = answerOptions(c).filter((o) => !sameValue(o.value, origValue));
      if (form.value === undefined || !options.some((o) => sameValue(o.value, form.value))) form.value = options[0]?.value;
      select = h('select', {
        class: 'input input--sm',
        onchange: (e) => {
          form.value = JSON.parse(e.target.value);
          preview.textContent = previewText(ev, c, form.value);
        },
      }, options.map((o) => h('option', { value: JSON.stringify(o.value), selected: sameValue(o.value, form.value) }, o.label)));
      preview = h('div', { class: 'decision-preview' }, previewText(ev, c, form.value));
      children.push(
        h('div', { class: 'inline-form__row' }, h('span', { class: 'appeal-box__key' }, `Было: ${answerLabel(c, origValue)} · Новая оценка`), select),
        preview
      );
    }

    const reason = h('textarea', {
      class: 'input', rows: '2', placeholder: 'Причина решения (обязательно)',
      oninput: (e) => (form.reason = e.target.value),
    });
    reason.value = form.reason || '';
    children.push(
      reason,
      h('div', { class: 'inline-form__actions' },
        h('button', {
          class: `btn btn--sm ${form.kind === 'confirm' ? 'btn--primary' : 'btn--dark'}`,
          type: 'button',
          onclick: () => submitDecision(ev, c, appeal, form.kind, form.value, reason.value),
        }, form.kind === 'confirm' ? 'Подтвердить' : 'Сохранить новую оценку'),
        h('button', { class: 'btn btn--text btn--sm', type: 'button', onclick: () => closeForms() }, 'Отмена')
      )
    );
    return h('div', { class: 'inline-form inline-form--reviewer' }, ...children);
  }

  function openDecision(c, kind) {
    state.ui.decision = { criterionId: c.id, kind, value: undefined, reason: '' };
    renderEvalPanel();
    focusField(`[data-criterion="${c.id}"] .inline-form--reviewer textarea`);
  }

  function closeForms() {
    state.ui.appealFor = null;
    state.ui.decision = null;
    state.ui.draft = '';
    renderEvalPanel();
  }

  function focusField(selector) {
    const el = $(selector);
    if (el) {
      el.focus();
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function answerOptions(c) {
    const opts =
      c.type === 'scale'
        ? c.scale.map((s) => ({ value: Number(s.value), label: `${s.value} — ${s.label}` }))
        : c.type === 'critical'
          ? [{ value: true, label: 'Да — нарушение выявлено' }, { value: false, label: 'Нет — нарушений нет' }]
          : [{ value: true, label: 'Да' }, { value: false, label: 'Нет' }];
    if (c.na_allowed && c.type !== 'critical') opts.push({ value: NA, label: 'N/A — критерий неприменим' });
    return opts;
  }

  const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /** Предпросмотр: каким станет итог, если принять новую оценку (тот же алгоритм пересчёта). */
  function previewText(ev, c, value) {
    const before = computeScore(state.checklist, finalAnswers(ev)).total;
    const answers = finalAnswers(ev);
    answers[c.id] = { ...answers[c.id], value };
    const after = computeScore(state.checklist, answers).total;
    return `Итог: ${before ?? '—'} → ${after ?? '—'}${value === NA ? ' (вес критерия будет перераспределён)' : ''}`;
  }

  /** Проверка, что сервер вернул полную оценку: есть id и ответ по каждому критерию чек-листа. */
  function assertEvaluation(ev, checklist) {
    const complete =
      ev && typeof ev === 'object' && typeof ev.id === 'string' &&
      ev.answers && typeof ev.answers === 'object' &&
      checklist.criteria.every((c) => ev.answers[c.id] && 'value' in ev.answers[c.id]);
    if (!complete) throw new ApiError('Сервер вернул неполный результат оценки', { code: 'INCOMPLETE' });
    return ev;
  }

  /** Оценка диалога (по умолчанию — открытого). Ошибки не ломают интерфейс: тост + состояние в панели. */
  async function runEvaluation(convIdArg) {
    const convId = typeof convIdArg === 'string' ? convIdArg : state.current && state.current.conversation_id;
    if (!convId || state.evaluating.has(convId)) return; // защита от двойного клика
    if (!state.checklist) return setStatus('Чек-лист не загружен — обновите страницу', true);
    if (!state.current || state.current.conversation_id !== convId) {
      location.hash = `#/conversations/${encodeURIComponent(convId)}`;
      await openConversation(convId);
      if (!state.current || state.current.conversation_id !== convId) return;
    }
    // Оценка выполняется по сохранённой версии — несохранённые правки сначала сохраняем.
    if (state.dirty && !(await saveChecklist())) return;

    const checklist = state.checklist;
    state.evaluating.add(convId);
    state.evalErrors.delete(convId);
    evalStartedAt.set(convId, Date.now());
    if (!elapsedTicker) elapsedTicker = setInterval(tickElapsed, 1000);
    renderEvalPanel();
    try {
      const ev = assertEvaluation(
        await api.evaluate({ group_id: state.groupId, conversation_id: convId, checklist_id: checklist.id }),
        checklist
      );
      const i = state.evaluations.findIndex((e) => e.id === ev.id);
      if (i >= 0) state.evaluations[i] = ev;
      else state.evaluations.push(ev);
      const cost = ev.cost && typeof ev.cost.usd === 'number' ? ` · $${ev.cost.usd.toFixed(4)}` : '';
      toast({ type: 'success', title: `Оценка готова: ${convId}`, message: `Итог ${ev.total ?? '—'} / 100${cost}` });
    } catch (err) {
      const d = notifyError(err, 'Оценка не выполнена', { label: 'Повторить', onClick: () => runEvaluation(convId) });
      state.evalErrors.set(convId, d);
    } finally {
      state.evaluating.delete(convId);
      evalStartedAt.delete(convId);
      renderConvSelect();
      if (state.current && state.current.conversation_id === convId) renderEvalPanel();
      else renderEvalButton();
    }
  }

  /* =====================================================================
   * 8. Апелляции
   * ===================================================================== */

  /* ---------- данные апелляций ---------- */

  /** Апелляции к текущей версии оценки (после переоценки старые апелляции не применяются). */
  function appealsFor(ev) {
    return state.appeals.filter(
      (a) => a.evaluation_id === ev.id && (!a.evaluation_updated_at || a.evaluation_updated_at === ev.updated_at)
    );
  }

  function appealFor(ev, criterionId) {
    const list = appealsFor(ev).filter((a) => a.criterion_id === criterionId);
    return list[list.length - 1] || null;
  }

  /** Ответы с учётом решений проверяющего: «Изменить оценку» заменяет ответ модели. */
  function finalAnswers(ev) {
    const answers = { ...(ev.answers || {}) };
    for (const a of appealsFor(ev)) {
      if (a.status === 'changed' && a.decision) answers[a.criterion_id] = { ...answers[a.criterion_id], value: a.decision.value };
    }
    return answers;
  }

  function finalTotal(ev) {
    return computeScore(state.checklist, finalAnswers(ev)).total;
  }

  async function submitAppeal(ev, c, comment) {
    comment = (comment || '').trim();
    if (!comment) return setStatus('Добавьте комментарий к апелляции', true);
    const now = new Date().toISOString();
    const appeal = {
      id: `ap-${Date.now()}`,
      evaluation_id: ev.id,
      evaluation_updated_at: ev.updated_at,
      conversation_id: ev.conversation_id,
      group_id: ev.group_id,
      checklist_id: ev.checklist_id,
      criterion_id: c.id,
      criterion_title: c.title,
      original_answer: ev.answers[c.id],
      comment,
      status: 'open', // open → confirmed | changed
      decision: null, // { value, reason, decided_at, total_before, total_after }
      created_at: now,
    };
    try {
      const saved = await api.put('appeals', appeal);
      state.appeals.push(saved);
      state.ui.appealFor = null;
      state.ui.draft = '';
      updateAppealsCount();
      renderEvalPanel();
      setStatus(`Апелляция по критерию «${c.title}» сохранена. Переключитесь в режим «Проверяющий», чтобы рассмотреть её.`);
    } catch (err) {
      notifyError(err, 'Апелляция не сохранена');
    }
  }

  async function submitDecision(ev, c, appeal, kind, value, reason) {
    reason = (reason || '').trim();
    if (!reason) return setStatus('Укажите причину решения', true);
    const origValue = appeal.original_answer ? normValue(appeal.original_answer.value) : undefined;
    if (kind === 'change' && (value === undefined || sameValue(value, origValue))) {
      return setStatus('Новая оценка совпадает с исходной — используйте «Подтвердить оценку»', true);
    }

    const totalBefore = finalTotal(ev);
    const updated = {
      ...appeal,
      status: kind === 'confirm' ? 'confirmed' : 'changed',
      decision: { value: kind === 'confirm' ? origValue : value, reason, decided_at: new Date().toISOString() },
    };
    // Пересчёт итога на фронтенде тем же алгоритмом (N/A исключает вес и перераспределяет его).
    const others = state.appeals.filter((a) => a.id !== appeal.id);
    const totalAfter = (() => {
      const saved = state.appeals;
      state.appeals = [...others, updated];
      const t = finalTotal(ev);
      state.appeals = saved;
      return t;
    })();
    updated.decision.total_before = totalBefore;
    updated.decision.total_after = totalAfter;

    try {
      const saved = await api.put('appeals', updated);
      state.appeals = state.appeals.map((a) => (a.id === saved.id ? saved : a));
      state.ui.decision = null;
      updateAppealsCount();
      renderEvalPanel();
      renderConvSelect();
      setStatus(
        kind === 'confirm'
          ? `Оценка по «${c.title}» подтверждена. Итог ${totalAfter ?? '—'}`
          : `Оценка по «${c.title}» изменена. Итог пересчитан: ${totalBefore ?? '—'} → ${totalAfter ?? '—'}`
      );
    } catch (err) {
      notifyError(err, 'Решение не сохранено');
    }
  }

  function updateAppealsCount() {
    const open = state.appeals.filter((a) => a.status === 'open').length;
    const el = $('#appeals-count');
    el.textContent = open;
    el.hidden = !open;
  }

  /* ---------- светлая / тёмная тема ---------- */

  const THEME_KEY = 'cqa-theme';
  const darkQuery = typeof root.matchMedia === 'function' ? root.matchMedia('(prefers-color-scheme: dark)') : null;

  function savedTheme() {
    try {
      const t = localStorage.getItem(THEME_KEY);
      return t === 'dark' || t === 'light' ? t : null;
    } catch {
      return null; // хранилище недоступно — следуем системной теме
    }
  }

  function applyTheme(theme, { save = false } = {}) {
    const t = theme === 'dark' ? 'dark' : 'light';
    $('#cqa-app').dataset.theme = t;
    const btn = $('#theme-toggle');
    if (btn) {
      const label = t === 'dark' ? 'Светлая тема' : 'Тёмная тема';
      btn.setAttribute('aria-label', label);
      btn.title = label;
      btn.setAttribute('aria-pressed', String(t === 'dark'));
    }
    if (save) {
      try {
        localStorage.setItem(THEME_KEY, t);
      } catch {
        /* не запомнится — не страшно */
      }
    }
  }

  /** Тема: выбор пользователя, иначе системная настройка (и её изменения, пока выбор не сделан). */
  function initTheme() {
    applyTheme(savedTheme() || (darkQuery && darkQuery.matches ? 'dark' : 'light'));
    $('#theme-toggle').addEventListener('click', () => {
      applyTheme($('#cqa-app').dataset.theme === 'dark' ? 'light' : 'dark', { save: true });
    });
    if (darkQuery) {
      const followSystem = () => {
        if (!savedTheme()) applyTheme(darkQuery.matches ? 'dark' : 'light');
      };
      if (typeof darkQuery.addEventListener === 'function') darkQuery.addEventListener('change', followSystem);
      // Запасной путь: некоторые встроенные браузеры не присылают событие change —
      // сверяемся с системной темой, когда окно снова получает фокус.
      root.addEventListener('focus', followSystem);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') followSystem();
      });
    }
  }

  /* ---------- режим «Оператор / Проверяющий» ---------- */

  function setMode(mode) {
    state.mode = mode === 'reviewer' ? 'reviewer' : 'operator';
    try {
      localStorage.setItem('cqa-mode', state.mode);
    } catch {
      /* хранилище может быть недоступно — режим просто не запомнится */
    }
    $('#cqa-app').classList.toggle('is-reviewer', state.mode === 'reviewer');
    $$('.mode-switch__btn').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === state.mode)));
    state.ui.appealFor = null;
    state.ui.decision = null;
    renderEvalPanel();
    if (parseRoute().view === 'appeals') renderAppeals();
  }

  /* ---------- экран «Апелляции» (сводный список) ---------- */

  async function renderAppeals() {
    const box = $('#appeals-list');
    if (!box.children.length || box.querySelector('.empty')) box.replaceChildren(Skeleton.rows(3));
    try {
      const list = await api.list('appeals');
      state.appeals = Array.isArray(list) ? list.filter((a) => a && a.id) : [];
      updateAppealsCount();
    } catch (err) {
      const d = notifyError(err, 'Не удалось загрузить апелляции');
      if (!state.appeals.length) {
        return box.replaceChildren(errorState(d.title, d.message, { label: 'Повторить', onClick: renderAppeals }));
      }
    }
    if (!state.appeals.length) {
      return box.replaceChildren(emptyState('⚖️', 'Апелляций пока нет. Оспорить оценку можно в карточке критерия.'));
    }
    const order = { open: 0, changed: 1, confirmed: 2 };
    const list = [...state.appeals].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || String(b.created_at).localeCompare(String(a.created_at)));
    box.replaceChildren(
      ...list.map((a) => {
        const [label, cls] = APPEAL_STATUS[a.status] || [a.status, ''];
        const c = state.checklist && state.checklist.criteria.find((x) => x.id === a.criterion_id);
        const fmt = (v) => (c ? answerLabel(c, v) : JSON.stringify(v));
        const firstEvidence = (a.original_answer?.evidence || [])[0];
        return h('div', { class: 'appeal' },
          h('div', { class: 'appeal__head' },
            h('span', { class: 'pill pill--dark' }, a.conversation_id),
            a.criterion_title || a.criterion_id,
            h('span', { class: `pill ${cls}` }, label)
          ),
          h('p', { class: 'appeal__comment' }, `Оператор: ${a.comment}`),
          a.decision
            ? h('p', { class: 'appeal__comment' },
                `Проверяющий: ${a.status === 'changed' ? `${fmt(a.original_answer?.value)} → ${fmt(a.decision.value)}` : 'оценка подтверждена'}. ${a.decision.reason}`,
                a.decision.total_before != null ? ` Итог ${a.decision.total_before} → ${a.decision.total_after}.` : '')
            : h('p', { class: 'appeal__comment muted' }, `Спорная оценка: ${fmt(a.original_answer?.value)}`),
          h('a', {
            class: 'small',
            href: firstEvidence != null ? msgLink(a.conversation_id, firstEvidence) : `#/conversations/${encodeURIComponent(a.conversation_id)}`,
          }, state.mode === 'reviewer' && a.status === 'open' ? 'Рассмотреть в карточке →' : 'Открыть диалог →')
        );
      })
    );
  }

  /* =====================================================================
   * 9. Левая зона: редактор чек-листа
   * ===================================================================== */

  function scaleToText(scale) {
    return (scale || []).map((s) => `${s.value} — ${s.label}`).join('\n');
  }

  function textToScale(text) {
    return text
      .split('\n')
      .map((line) => line.match(/^\s*(-?\d+(?:[.,]\d+)?)\s*[—–-]?\s*(.*)$/))
      .filter(Boolean)
      .map((m) => ({ value: Number(m[1].replace(',', '.')), label: m[2].trim() }))
      .sort((a, b) => b.value - a.value);
  }

  function setDirty(value) {
    state.dirty = value;
    $('#cl-dirty').hidden = !value;
  }

  function updateWeightSum() {
    const cl = state.checklist;
    const sum = cl.criteria.filter((c) => c.type !== 'critical').reduce((a, c) => a + (Number(c.weight) || 0), 0);
    const ok = sum === 100;
    $('#cl-weight').classList.toggle('is-off', !ok);
    $('#cl-weight-value').textContent = `${sum} / 100`;
    $('#cl-weight-fill').style.width = `${Math.min(sum, 100)}%`;
    $('#cl-weight-hint').textContent = ok ? '' : 'По правилам сумма весов = 100. Итог всё равно нормируется к 100.';
  }

  function renderChecklistEditor() {
    const cl = state.checklist;
    if (!cl) return;

    $('#cl-select').replaceChildren(
      ...state.checklists.map((c) => h('option', { value: c.id, selected: c.id === cl.id }, `${c.name} · v${c.version}`))
    );
    $('#cl-name').value = cl.name;

    const tpl = $('#tpl-criterion');
    const makeCard = (c) => {
      const node = tpl.content.firstElementChild.cloneNode(true);
      const field = (name) => $(`[data-field="${name}"]`, node);

      $('.crit__num', node).textContent = String(cl.criteria.indexOf(c) + 1).padStart(2, '0');
      field('section').replaceChildren(...cl.sections.map((s) => h('option', { value: s.id }, s.title)));
      for (const name of ['id', 'title', 'section', 'type', 'weight', 'description', 'na_condition']) field(name).value = c[name] ?? '';
      field('na_allowed').checked = Boolean(c.na_allowed);
      field('scale').value = scaleToText(c.scale);

      const sync = () => {
        node.classList.toggle('crit--critical', c.type === 'critical');
        $('[data-role="scale"]', node).hidden = c.type !== 'scale';
        $('[data-role="na-condition"]', node).hidden = !c.na_allowed;
        field('weight').disabled = c.type === 'critical';
        field('na_allowed').disabled = c.type === 'critical';
      };
      sync();

      node.addEventListener('input', (e) => {
        const name = e.target.dataset.field;
        if (!name) return;
        if (name === 'na_allowed') c.na_allowed = e.target.checked;
        else if (name === 'weight') c.weight = Number(e.target.value) || 0;
        else if (name === 'scale') c.scale = textToScale(e.target.value);
        else if (name === 'id') c.id = e.target.value.trim(); // criterion_id для формата JSON 1.0
        else c[name] = e.target.value;
        if (name === 'type') {
          if (c.type === 'critical') {
            c.weight = 0;
            c.na_allowed = false;
            field('weight').value = 0;
            field('na_allowed').checked = false;
          }
          if (c.type === 'scale' && !(c.scale && c.scale.length)) {
            c.scale = [{ value: 10, label: 'Полностью' }, { value: 5, label: 'Частично' }, { value: 0, label: 'Нет' }];
            field('scale').value = scaleToText(c.scale);
          }
        }
        sync();
        setDirty(true);
        updateWeightSum();
        if (name === 'section') renderChecklistEditor(); // перегруппировать по секциям
      });
      $('[data-action="remove"]', node).addEventListener('click', () => {
        if (!root.confirm(`Удалить критерий «${c.title}»?`)) return;
        cl.criteria.splice(cl.criteria.indexOf(c), 1);
        setDirty(true);
        renderChecklistEditor();
      });
      return node;
    };

    // Критерии сгруппированы по секциям чек-листа.
    const nodes = cl.sections.flatMap((s) => {
      const crit = cl.criteria.filter((c) => c.section === s.id);
      return crit.length ? [h('div', { class: 'criteria-section' }, s.title), ...crit.map(makeCard)] : [];
    });
    const orphans = cl.criteria.filter((c) => !cl.sections.some((s) => s.id === c.section));
    if (orphans.length) nodes.push(h('div', { class: 'criteria-section' }, 'Без секции'), ...orphans.map(makeCard));

    $('#cl-criteria').replaceChildren(...nodes);
    updateWeightSum();
  }

  function validateChecklist(cl) {
    const errors = [];
    if (!cl.name.trim()) errors.push('Укажите название чек-листа');
    const ids = new Set();
    cl.criteria.forEach((c, i) => {
      const label = c.title || `Критерий ${i + 1}`;
      if (!c.title.trim()) errors.push(`Критерий ${i + 1}: нет названия`);
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(c.id || '')) {
        errors.push(`${label}: criterion_id «${c.id}» — латиница в нижнем регистре, цифры и «_», например closure`);
      }
      if (ids.has(c.id)) errors.push(`${label}: criterion_id «${c.id}» повторяется`);
      ids.add(c.id);
      if (c.type !== 'critical' && !(c.weight > 0)) errors.push(`${label}: вес должен быть больше 0`);
      if (c.type === 'scale' && (!c.scale || c.scale.length < 2)) errors.push(`${label}: в шкале нужно минимум 2 ступени`);
      if (c.type === 'scale' && c.scale && !(scaleMax(c) > 0)) errors.push(`${label}: верхняя ступень шкалы должна быть больше 0`);
    });
    return errors;
  }

  /** Сохраняет чек-лист. Возвращает true при успехе. */
  async function saveChecklist() {
    const cl = state.checklist;
    const errors = validateChecklist(cl);
    if (errors.length) {
      setStatus(errors.join('; '), true);
      return false;
    }
    try {
      const saved = await api.put('checklists', cl);
      const i = state.checklists.findIndex((c) => c.id === saved.id);
      if (i >= 0) state.checklists[i] = saved;
      else state.checklists.push(saved);
      state.checklist = structuredClone(saved);
      setDirty(false);
      renderChecklistEditor();
      renderConvSelect();
      renderEvalPanel();
      setStatus(`Чек-лист «${saved.name}» v${saved.version} сохранён`);
      return true;
    } catch (err) {
      notifyError(err, 'Чек-лист не сохранён');
      return false;
    }
  }

  function bindChecklistToolbar() {
    // Без загруженного чек-листа (сервер был недоступен при старте) кнопки ничего не ломают.
    const needChecklist = (fn) => (...args) => {
      if (!state.checklist) return toast({ type: 'warning', title: 'Чек-лист не загружен', message: 'Проверьте, что сервер запущен, и обновите страницу.' });
      return fn(...args);
    };
    $('#cl-select').addEventListener('change', needChecklist((e) => {
      if (state.dirty && !root.confirm('Есть несохранённые изменения. Переключить чек-лист без сохранения?')) {
        e.target.value = state.checklist.id;
        return;
      }
      state.checklist = structuredClone(state.checklists.find((c) => c.id === e.target.value));
      setDirty(false);
      renderChecklistEditor();
      renderConvSelect();
      renderEvalPanel();
    }));
    $('#cl-name').addEventListener('input', needChecklist((e) => {
      state.checklist.name = e.target.value;
      setDirty(true);
    }));
    $('#cl-add').addEventListener('click', needChecklist(() => {
      const cl = state.checklist;
      // Временный criterion_id; для сдачи результатов замените его кодом, который дадут организаторы.
      let n = 1;
      while (cl.criteria.some((c) => c.id === `new_criterion_${n}`)) n++;
      const section = (cl.sections.find((s) => s.id !== 'critical') || cl.sections[0]).id;
      cl.criteria.push({
        id: `new_criterion_${n}`,
        section,
        title: 'Новый критерий',
        type: 'binary',
        weight: 10,
        na_allowed: false,
        description: '',
        na_condition: '',
      });
      setDirty(true);
      renderChecklistEditor();
      const cards = $$('#cl-criteria .crit');
      const last = cards.find((n) => $('.crit__title', n).value === 'Новый критерий') || cards[cards.length - 1];
      last.scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('.crit__title', last).select();
    }));
    $('#cl-copy').addEventListener('click', needChecklist(async () => {
      const base = state.checklist;
      const version = Math.max(...state.checklists.map((c) => c.version || 1)) + 1;
      const copy = structuredClone(base);
      copy.id = `${base.id.replace(/-v\d+$/, '')}-v${version}`;
      copy.version = version;
      delete copy.created_at;
      delete copy.updated_at;
      state.checklist = copy;
      await saveChecklist();
    }));
    $('#cl-save').addEventListener('click', needChecklist(saveChecklist));
  }

  /* =====================================================================
   * 10. Запуск
   * ===================================================================== */

  async function syncFromApi() {
    const btn = $('#sync-btn');
    btn.disabled = true;
    setStatus(`Запрашиваю набор ${state.groupId} у API организаторов…`);
    try {
      const r = await api.syncDataset(state.groupId);
      setStatus(`Скачано ${r.saved} из ${r.total_records} диалогов`);
      await loadConversations();
    } catch (err) {
      notifyError(err, 'Не удалось обновить набор из API');
    } finally {
      btn.disabled = false;
    }
  }

  async function init() {
    initTheme();
    $('#group-id').value = state.groupId;
    $('#group-id').addEventListener('change', (e) => {
      state.groupId = e.target.value.trim() || 'DEV';
      state.current = null;
      renderPlayer(); // скрыть плеер и остановить запись
      $('#conv-meta').replaceChildren();
      $('#conv-card').replaceChildren(emptyState('💬', 'Выберите диалог в списке выше'));
      $('#eval-panel').replaceChildren(emptyState('📋', 'Здесь появятся баллы, обоснования и реплики-доказательства'));
      renderEvalButton();
      loadConversations();
    });
    $('#sync-btn').addEventListener('click', syncFromApi);
    $('#conv-select').addEventListener('change', (e) => {
      if (e.target.value) location.hash = `#/conversations/${encodeURIComponent(e.target.value)}`;
    });
    ['#f-lang', '#f-channel'].forEach((s) => $(s).addEventListener('change', renderConvSelect));
    $('#eval-btn').addEventListener('click', runEvaluation);
    $$('.mode-switch__btn').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    bindPlayer();
    bindChecklistToolbar();
    root.addEventListener('beforeunload', (e) => {
      if (state.dirty) e.preventDefault();
    });

    // Пока данные грузятся — скелеты вместо пустых блоков.
    $('#cl-criteria').replaceChildren(Skeleton.criteria());
    $('#kpi-bar').replaceChildren(...Skeleton.kpis());

    try {
      const [checklists, evaluations, appeals] = await Promise.all([
        api.list('checklists'), api.list('evaluations'), api.list('appeals'),
      ]);
      // Повреждённые записи отбрасываем, а не роняем интерфейс.
      state.checklists = Array.isArray(checklists) ? checklists.filter((c) => c && Array.isArray(c.criteria)) : [];
      state.evaluations = Array.isArray(evaluations) ? evaluations.filter((e) => e && e.id && e.conversation_id) : [];
      state.appeals = Array.isArray(appeals) ? appeals.filter((a) => a && a.id) : [];
      if (!state.checklists.length) throw new ApiError('Чек-лист не найден на сервере', { code: 'BAD_RESPONSE' });
      state.checklist = structuredClone(state.checklists[state.checklists.length - 1]);
      renderChecklistEditor();
      updateAppealsCount();
    } catch (err) {
      const d = notifyError(err, 'Не удалось загрузить данные');
      $('#cl-criteria').replaceChildren(errorState(d.title, d.message, { label: 'Обновить страницу', onClick: () => location.reload() }));
    }

    let savedMode = 'operator';
    try {
      savedMode = localStorage.getItem('cqa-mode') || 'operator';
    } catch {
      /* без хранилища — режим по умолчанию */
    }
    setMode(savedMode);

    await loadConversations();
    root.addEventListener('hashchange', onRoute);
    if (!location.hash) location.hash = '#/conversations';
    else onRoute();
  }

  /* =====================================================================
   * 11. Защита от «белого экрана»
   *     Ошибка в отрисовке одного блока показывает аккуратное состояние ошибки в этом блоке
   *     и уведомление, но не ломает остальной интерфейс.
   * ===================================================================== */

  function guard(label, fn, fallback) {
    const onError = (err) => {
      console.error(`[CQA] Ошибка отрисовки: ${label}`, err);
      try {
        if (fallback) fallback(err);
      } catch (e) {
        console.error('[CQA] Ошибка в обработчике ошибки', e);
      }
      toast({
        type: 'error',
        title: `Не удалось показать ${label}`,
        message: 'Данные неполные или повреждены. Обновите страницу или повторите действие.',
      });
    };
    return function guarded(...args) {
      try {
        const result = fn.apply(this, args);
        return result && typeof result.then === 'function' ? result.catch(onError) : result;
      } catch (err) {
        return onError(err);
      }
    };
  }

  const retryCurrent = () => state.current && runEvaluation(state.current.conversation_id);
  renderEvalPanel = guard('результат оценки', renderEvalPanel, () =>
    $('#eval-panel').replaceChildren(errorState(NOT_CONFIDENT, 'Результат оценки неполный. Попробуйте повторить запрос.', { label: 'Повторить оценку', onClick: retryCurrent })));
  renderTranscript = guard('транскрипт', renderTranscript, () =>
    $('#conv-card').replaceChildren(errorState('Транскрипт не удалось показать', 'Данные диалога неполные. Выберите диалог ещё раз.')));
  renderConvMeta = guard('карточку диалога', renderConvMeta, () => $('#conv-meta').replaceChildren());
  renderPlayer = guard('плеер записи', renderPlayer, () => ($('#call-player').hidden = true));
  renderConvSelect = guard('список диалогов', renderConvSelect);
  renderDashboard = guard('аналитику', renderDashboard, () =>
    $('#kpi-bar').replaceChildren(h('div', { class: 'kpi kpi--empty' }, h('div', { class: 'kpi__sub' }, 'Аналитика временно недоступна.'))));
  renderChecklistEditor = guard('чек-лист', renderChecklistEditor, () =>
    $('#cl-criteria').replaceChildren(errorState('Чек-лист не удалось показать', 'Обновите страницу.', { label: 'Обновить', onClick: () => location.reload() })));
  renderAppeals = guard('апелляции', renderAppeals, () =>
    $('#appeals-list').replaceChildren(errorState('Апелляции не удалось показать', 'Обновите страницу.')));
  onRoute = guard('страницу', onRoute);

  // Последний рубеж: любая непойманная ошибка — уведомление, а не тихо сломанная страница.
  if (typeof root.addEventListener === 'function' && typeof document !== 'undefined') {
    root.addEventListener('error', (e) => {
      if (!e.error) return; // ошибки загрузки ресурсов (аудио и т. п.) обрабатываются на месте
      console.error('[CQA] Непредвиденная ошибка', e.error);
      toast({ type: 'error', title: 'Непредвиденная ошибка интерфейса', message: 'Действие не выполнено, данные не потеряны. Попробуйте ещё раз.' });
    });
    root.addEventListener('unhandledrejection', (e) => {
      console.error('[CQA] Необработанная ошибка', e.reason);
      const d = describeError(e.reason, 'Действие не выполнено');
      toast({ type: 'error', title: d.title, message: d.message });
    });
  }

  // Публичное API модуля (удобно для отладки в консоли и будущей интеграции).
  root.CQA = { config: CONFIG, state, api, computeScore, finalAnswers, computeDashboard, toast, seekToTime, seekToTurn, player, NA };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
