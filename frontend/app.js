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

  function roundTo(x, digits) {
    const f = Math.pow(10, digits);
    return Math.round((x + Number.EPSILON) * f) / f;
  }

  function scaleMax(criterion) {
    return Math.max(...(criterion.scale || []).map((s) => Number(s.value)));
  }

  /**
   * @param checklist  { criteria: [...], sections: [...], rounding }
   * @param answers    { [criterionId]: { value: true | false | number | 'NA', ... } }
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
      const value = answers[c.id] ? answers[c.id].value : undefined;
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
      } else if (value === undefined || value === null) {
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

  async function request(method, path, body) {
    const res = await fetch(CONFIG.apiBase + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  const q = (groupId) => `?group_id=${encodeURIComponent(groupId)}`;
  const api = {
    syncDataset: (g) => request('POST', `/dataset/sync${q(g)}`),
    conversations: (g) => request('GET', `/conversations${q(g)}`),
    conversation: (g, id) => request('GET', `/conversations/${encodeURIComponent(id)}${q(g)}`),
    audioUrl: (g, id) => `${CONFIG.apiBase}/audio/${encodeURIComponent(id)}${q(g)}`,
    list: (col) => request('GET', `/store/${col}`),
    put: (col, doc) => request('PUT', `/store/${col}/${encodeURIComponent(doc.id)}`, doc),
    evaluate: (payload) => request('POST', '/evaluate', payload),
  };

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

  let statusTimer;
  function setStatus(text, isError) {
    const el = $('#status');
    clearTimeout(statusTimer);
    if (!text) return (el.hidden = true);
    el.textContent = text;
    el.classList.toggle('is-error', Boolean(isError));
    el.hidden = false;
    statusTimer = setTimeout(() => (el.hidden = true), isError ? 8000 : 4000);
  }

  const SPEAKER = { client: 'Клиент', operator: 'Оператор', bot: 'Бот', system: 'Система' };
  const CHANNEL = { 'agent chat': 'Чат', 'voice call': 'Звонок' };
  const LANG = { RU: 'Русский', KZ: 'Қазақша', EN: 'English' };

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
    try {
      const data = await api.conversations(state.groupId);
      state.list = data.records;
      renderConvSelect();
    } catch (err) {
      state.list = [];
      renderConvSelect();
      setStatus(err.message, true);
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
  }

  async function openConversation(id) {
    try {
      state.current = await api.conversation(state.groupId, id);
    } catch (err) {
      setStatus(err.message, true);
      return;
    }
    renderConvSelect();
    renderConvMeta();
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
   * 6. Правая зона: транскрипт + запись звонка
   * ===================================================================== */

  const isIsoTime = (t) => /^\d{4}-\d{2}-\d{2}T/.test(t);
  function fmtOffset(sec) {
    const s = Math.max(0, Math.floor(sec));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function renderTranscript() {
    const rec = state.current;
    const box = $('#conv-card');
    const isCall = Boolean(rec.audio_url);

    // Для звонков (ISO 8601) считаем смещение от первой реплики — по нему перематываем запись.
    // Исходная метка сохраняется и показывается во всплывающей подсказке.
    const t0 = isCall && isIsoTime(rec.transcript[0]?.timestamp) ? Date.parse(rec.transcript[0].timestamp) : null;
    let audio = null;
    let audioBox = null;
    if (isCall) {
      audio = h('audio', { controls: true, preload: 'none', src: api.audioUrl(state.groupId, rec.conversation_id) });
      audioBox = h('div', { class: 'audio-box' },
        audio,
        h('div', { class: 'small muted' },
          'Нажмите на время реплики, чтобы перейти к фрагменту записи. ',
          h('a', { href: rec.audio_url, target: '_blank', rel: 'noopener' }, 'Плеер организаторов ↗')
        )
      );
    }

    const transcript = h('div', { class: 'transcript' },
      rec.transcript.map((m, i) => {
        let time;
        if (t0 != null && isIsoTime(m.timestamp)) {
          const offset = (Date.parse(m.timestamp) - t0) / 1000;
          time = h('button', {
            class: 'msg__time', type: 'button', title: `${m.timestamp} — перейти к фрагменту записи`,
            onclick: () => { audio.currentTime = offset; audio.play().catch(() => {}); },
          }, `▶ ${fmtOffset(offset)}`);
        } else {
          time = h('span', { class: 'msg__time', title: m.timestamp }, m.timestamp);
        }
        return h('div', { class: `msg msg--${m.speaker}`, id: `msg-${i}` },
          h('div', { class: 'msg__meta' },
            h('a', { class: 'msg__speaker', href: msgLink(rec.conversation_id, i), title: 'Ссылка на реплику' }, `#${i} ${SPEAKER[m.speaker] || m.speaker}`),
            time
          ),
          h('div', { class: 'msg__text' }, m.text)
        );
      })
    );

    box.replaceChildren(...[audioBox, transcript].filter(Boolean));
    box.scrollTop = 0;
  }

  function highlightMessage(idx) {
    $$('.msg.is-highlight').forEach((m) => m.classList.remove('is-highlight'));
    const el = document.getElementById(`msg-${idx}`);
    if (!el) return;
    void el.offsetWidth; // перезапуск анимации при повторном клике
    el.classList.add('is-highlight');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    btn.classList.toggle('is-loading', busy);
    $('.btn__label', btn).textContent = busy
      ? 'Оцениваем… ~20–40 с'
      : ev ? 'Переоценить оператора' : 'Оценить оператора';
  }

  function answerLabel(c, value) {
    if (value === NA) return 'N/A';
    if (value === undefined) return '—';
    if (c.type === 'scale') return `${value} / ${scaleMax(c)}`;
    return value ? 'Да' : 'Нет';
  }

  function answerTone(c, value) {
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

    const ev = evaluationFor(rec.conversation_id);
    if (!ev) {
      return panel.replaceChildren(
        emptyState('📋', [
          h('div', null, `Диалог ещё не оценён по чек-листу «${cl.name}».`),
          h('div', { class: 'small' }, 'Нажмите «Оценить оператора» — модель проставит ответы, баллы и реплики-доказательства.'),
        ])
      );
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
    const meta = ev.cost
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

    panel.replaceChildren(head, summary || '', meta || '', sectionBars, ...sections.filter(Boolean));
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
        orig.quote ? h('blockquote', { class: 'eval-quote', ...evidenceTarget(convId, evidence) }, orig.quote) : null,
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
    const origValue = appeal.original_answer ? appeal.original_answer.value : undefined;
    const fragment = (appeal.original_answer?.evidence || [])
      .slice(0, 3)
      .map((i) => rec.transcript[i] && h('div', { class: 'fragment__msg', ...evidenceTarget(rec.conversation_id, [i]) },
        h('span', { class: 'fragment__who' }, `#${i} ${SPEAKER[rec.transcript[i].speaker] || rec.transcript[i].speaker}: `),
        rec.transcript[i].text))
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

    const origValue = appeal.original_answer ? appeal.original_answer.value : undefined;
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

  async function runEvaluation() {
    const rec = state.current;
    if (!rec) return;
    // Оценка выполняется по сохранённой версии — несохранённые правки сначала сохраняем.
    if (state.dirty && !(await saveChecklist())) return;

    const convId = rec.conversation_id;
    state.evaluating.add(convId);
    renderEvalButton();
    $('#eval-panel').replaceChildren(emptyState('⏳', 'Модель анализирует диалог по чек-листу…'));
    try {
      const ev = await api.evaluate({ group_id: state.groupId, conversation_id: convId, checklist_id: state.checklist.id });
      const i = state.evaluations.findIndex((e) => e.id === ev.id);
      if (i >= 0) state.evaluations[i] = ev;
      else state.evaluations.push(ev);
      setStatus(`${convId}: ${ev.total ?? '—'} / 100 · $${ev.cost.usd.toFixed(4)}`);
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      state.evaluating.delete(convId);
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
      setStatus(err.message, true);
    }
  }

  async function submitDecision(ev, c, appeal, kind, value, reason) {
    reason = (reason || '').trim();
    if (!reason) return setStatus('Укажите причину решения', true);
    const origValue = appeal.original_answer ? appeal.original_answer.value : undefined;
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
      setStatus(err.message, true);
    }
  }

  function updateAppealsCount() {
    const open = state.appeals.filter((a) => a.status === 'open').length;
    const el = $('#appeals-count');
    el.textContent = open;
    el.hidden = !open;
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
    try {
      state.appeals = await api.list('appeals');
      updateAppealsCount();
    } catch (err) {
      setStatus(err.message, true);
    }
    const box = $('#appeals-list');
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
      for (const name of ['title', 'section', 'type', 'weight', 'description', 'na_condition']) field(name).value = c[name] ?? '';
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
      if (ids.has(c.id)) errors.push(`${label}: повторяющийся id`);
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
      setStatus(err.message, true);
      return false;
    }
  }

  function bindChecklistToolbar() {
    $('#cl-select').addEventListener('change', (e) => {
      if (state.dirty && !root.confirm('Есть несохранённые изменения. Переключить чек-лист без сохранения?')) {
        e.target.value = state.checklist.id;
        return;
      }
      state.checklist = structuredClone(state.checklists.find((c) => c.id === e.target.value));
      setDirty(false);
      renderChecklistEditor();
      renderConvSelect();
      renderEvalPanel();
    });
    $('#cl-name').addEventListener('input', (e) => {
      state.checklist.name = e.target.value;
      setDirty(true);
    });
    $('#cl-add').addEventListener('click', () => {
      const cl = state.checklist;
      let n = cl.criteria.length + 1;
      while (cl.criteria.some((c) => c.id === `c${String(n).padStart(2, '0')}`)) n++;
      const section = (cl.sections.find((s) => s.id !== 'critical') || cl.sections[0]).id;
      cl.criteria.push({
        id: `c${String(n).padStart(2, '0')}`,
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
    });
    $('#cl-copy').addEventListener('click', async () => {
      const base = state.checklist;
      const version = Math.max(...state.checklists.map((c) => c.version || 1)) + 1;
      const copy = structuredClone(base);
      copy.id = `${base.id.replace(/-v\d+$/, '')}-v${version}`;
      copy.version = version;
      delete copy.created_at;
      delete copy.updated_at;
      state.checklist = copy;
      await saveChecklist();
    });
    $('#cl-save').addEventListener('click', saveChecklist);
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
      setStatus(err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  async function init() {
    $('#group-id').value = state.groupId;
    $('#group-id').addEventListener('change', (e) => {
      state.groupId = e.target.value.trim() || 'DEV';
      state.current = null;
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
    bindChecklistToolbar();
    root.addEventListener('beforeunload', (e) => {
      if (state.dirty) e.preventDefault();
    });

    try {
      const [checklists, evaluations, appeals] = await Promise.all([
        api.list('checklists'), api.list('evaluations'), api.list('appeals'),
      ]);
      state.checklists = checklists;
      state.evaluations = evaluations;
      state.appeals = appeals;
      state.checklist = structuredClone(checklists[checklists.length - 1]);
      renderChecklistEditor();
      updateAppealsCount();
    } catch (err) {
      setStatus(`Сервер недоступен: ${err.message}`, true);
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

  // Публичное API модуля (удобно для отладки в консоли и будущей интеграции).
  root.CQA = { config: CONFIG, state, api, computeScore, finalAnswers, NA };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
