/* CQA — Conversation Quality Analytics, фронтенд.
 *
 * Чистый JavaScript без сборки. Весь код в одном пространстве имён window.CQA,
 * интерфейс монтируется в #cqa-app — так его проще перенести в HTML web resource Dynamics 365.
 * Адрес API задаётся через window.CQA_CONFIG = { apiBase: '...' } до подключения скрипта.
 */
(function (root) {
  'use strict';

  const CONFIG = Object.assign({ apiBase: '/api', groupId: 'DEV' }, root.CQA_CONFIG || {});

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
    list: [],
    current: null, // текущий диалог целиком
    checklists: [],
    checklist: null, // активный (редактируемый) чек-лист
    evaluations: [],
    evaluating: new Set(), // conversation_id, по которым идёт оценка
    appeals: [],
  };

  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));

  /** Создание элемента без innerHTML — тексты диалогов вставляются только как textContent. */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  let statusTimer;
  function setStatus(text, isError) {
    const el = $('#status');
    clearTimeout(statusTimer);
    if (!text) return (el.hidden = true);
    el.textContent = text;
    el.classList.toggle('is-error', Boolean(isError));
    el.hidden = false;
    if (!isError) statusTimer = setTimeout(() => (el.hidden = true), 4000);
  }

  const SPEAKER = { client: 'Клиент', operator: 'Оператор', bot: 'Бот', system: 'Система' };
  const CHANNEL = { 'agent chat': 'Чат', 'voice call': 'Звонок' };

  /* =====================================================================
   * 4. Роутинг по hash: ссылки-доказательства ведут прямо к реплике
   *    #/conversations/<id>/m/<index>   #/checklist   #/appeals
   * ===================================================================== */

  function msgLink(convId, idx) {
    return `#/conversations/${encodeURIComponent(convId)}/m/${idx}`;
  }

  function parseRoute() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    return { view: parts[0] || 'conversations', id: parts[1] || null, msg: parts[2] === 'm' ? Number(parts[3]) : null };
  }

  async function onRoute() {
    const r = parseRoute();
    $$('.cqa-view').forEach((v) => (v.hidden = v.dataset.view !== r.view));
    $$('.cqa-tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === r.view));

    if (r.view === 'conversations' && r.id) {
      if (!state.current || state.current.conversation_id !== r.id) await openConversation(r.id);
      if (r.msg != null) highlightMessage(r.msg);
    }
    if (r.view === 'checklist') renderChecklistEditor();
    if (r.view === 'appeals') renderAppeals();
  }

  /* =====================================================================
   * 5. Список диалогов
   * ===================================================================== */

  async function loadConversations() {
    try {
      const data = await api.conversations(state.groupId);
      state.list = data.records;
      renderList();
      setStatus(`Набор ${data.dataset_group_id}: ${data.records.length} диалогов (скачан ${new Date(data.fetched_at).toLocaleString()})`);
    } catch (err) {
      state.list = [];
      renderList();
      setStatus(err.message, true);
    }
  }

  function renderList() {
    const search = $('#f-search').value.trim().toLowerCase();
    const lang = $('#f-lang').value;
    const channel = $('#f-channel').value;
    const items = state.list.filter(
      (c) =>
        (!lang || c.language === lang) &&
        (!channel || c.channel === channel) &&
        (!search || c.conversation_id.toLowerCase().includes(search) || c.preview.toLowerCase().includes(search))
    );
    $('#conv-count').textContent = `Показано ${items.length} из ${state.list.length}`;
    const currentId = state.current && state.current.conversation_id;
    $('#conv-items').replaceChildren(
      ...items.map((c) =>
        h('li', null,
          h('a', { class: 'conv-item' + (c.conversation_id === currentId ? ' is-active' : ''), href: `#/conversations/${encodeURIComponent(c.conversation_id)}` },
            h('div', { class: 'conv-item__top' },
              c.conversation_id,
              h('span', { class: 'badge badge--muted' }, c.language),
              c.has_audio ? h('span', { class: 'badge badge--warn' }, '🎧 звонок') : null,
              evaluationFor(c.conversation_id) ? h('span', { class: 'badge' }, '✓') : null
            ),
            h('div', { class: 'conv-item__preview' }, c.preview)
          )
        )
      )
    );
  }

  /* =====================================================================
   * 6. Карточка диалога: транскрипт + запись
   * ===================================================================== */

  async function openConversation(id) {
    try {
      state.current = await api.conversation(state.groupId, id);
    } catch (err) {
      setStatus(err.message, true);
      return;
    }
    renderList();
    renderCard();
    renderEvalPanel();
  }

  const isIsoTime = (t) => /^\d{4}-\d{2}-\d{2}T/.test(t);
  function fmtOffset(sec) {
    const s = Math.max(0, Math.floor(sec));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function renderCard() {
    const rec = state.current;
    const card = $('#conv-card');
    const isCall = Boolean(rec.audio_url);

    // Для звонков (ISO 8601) считаем смещение от первой реплики — по нему перематываем запись.
    // Исходная метка сохраняется и показывается во всплывающей подсказке.
    const t0 = isCall && isIsoTime(rec.transcript[0]?.timestamp) ? Date.parse(rec.transcript[0].timestamp) : null;
    let audio = null;

    const head = h('div', { class: 'conv-card__head' },
      h('h2', null, rec.conversation_id),
      h('span', { class: 'badge badge--muted' }, CHANNEL[rec.channel] || rec.channel),
      h('span', { class: 'badge badge--muted' }, rec.language),
      h('span', { class: 'muted small' }, `${rec.transcript.length} реплик`)
    );

    let audioBox = null;
    if (isCall) {
      audio = h('audio', { controls: true, preload: 'none', src: api.audioUrl(state.groupId, rec.conversation_id) });
      audioBox = h('div', { class: 'audio-box' },
        audio,
        h('div', { class: 'small muted' },
          'Нажмите на время реплики, чтобы перейти к фрагменту записи. ',
          h('a', { href: rec.audio_url, target: '_blank', rel: 'noopener' }, 'Открыть плеер организаторов ↗')
        )
      );
    }

    const transcript = h('div', { class: 'transcript' },
      rec.transcript.map((m, i) => {
        let time;
        if (t0 != null && isIsoTime(m.timestamp)) {
          const offset = (Date.parse(m.timestamp) - t0) / 1000;
          time = h('button', {
            class: 'msg__time', type: 'button', title: m.timestamp,
            onclick: () => { audio.currentTime = offset; audio.play().catch(() => {}); },
          }, fmtOffset(offset));
        } else {
          time = h('span', { class: 'msg__time', title: m.timestamp }, m.timestamp);
        }
        return h('div', { class: `msg msg--${m.speaker}`, id: `msg-${i}`, 'data-idx': i },
          h('div', { class: 'msg__meta' },
            h('a', { class: 'msg__speaker', href: msgLink(rec.conversation_id, i), title: 'Ссылка на реплику' }, `#${i} ${SPEAKER[m.speaker] || m.speaker}`),
            time
          ),
          h('div', { class: 'msg__text' }, m.text)
        );
      })
    );

    card.replaceChildren(head, audioBox || '', transcript);
    card.scrollTop = 0;
  }

  function highlightMessage(idx) {
    $$('.msg.is-highlight').forEach((m) => m.classList.remove('is-highlight'));
    const el = document.getElementById(`msg-${idx}`);
    if (!el) return;
    el.classList.add('is-highlight');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* =====================================================================
   * 7. Панель оценки
   *    Формат сохранённой оценки (коллекция evaluations):
   *    { id, group_id, conversation_id, checklist_id, checklist_version,
   *      answers: { [criterionId]: { value, explanation, evidence: [msgIdx], checked_range: [from, to] } } }
   * ===================================================================== */

  function evaluationFor(convId) {
    const cl = state.checklist;
    return state.evaluations.find(
      (e) => e.conversation_id === convId && e.group_id === state.groupId && (!cl || e.checklist_id === cl.id)
    );
  }

  function answerLabel(c, value) {
    if (value === NA) return 'N/A';
    if (value === undefined) return '—';
    if (c.type === 'scale') return `${value} / ${scaleMax(c)}`;
    return value ? 'Да' : 'Нет';
  }

  function renderEvalPanel() {
    const panel = $('#eval-panel');
    const rec = state.current;
    const cl = state.checklist;
    if (!rec || !cl) return;

    const ev = evaluationFor(rec.conversation_id);
    const answers = (ev && ev.answers) || {};
    const score = computeScore(cl, answers);
    const rowById = Object.fromEntries(score.rows.map((r) => [r.id, r]));

    const busy = state.evaluating.has(rec.conversation_id);
    const runBtn = h('button', { class: 'btn btn--primary', type: 'button', onclick: runEvaluation, disabled: busy },
      busy ? 'Оценивается… (~20–40 с)' : ev ? 'Переоценить' : 'Запустить оценку');

    const header = h('div', null,
      h('h3', null, cl.name, ' ', h('span', { class: 'muted small' }, `v${cl.version}`)),
      h('div', { class: 'eval-total' },
        h('span', { class: 'eval-total__value' }, score.total == null ? '—' : score.total),
        h('span', { class: 'muted' }, '/ 100'),
        score.has_critical ? h('span', { class: 'badge badge--danger' }, 'Грубая ошибка') : null,
        ev && !score.complete ? h('span', { class: 'badge badge--warn' }, 'неполная оценка') : null
      ),
      runBtn,
      ev && ev.summary ? h('p', { class: 'eval-summary' }, ev.summary) : null,
      ev && ev.cost ? h('div', { class: 'small muted' },
        `${ev.model} · $${ev.cost.usd.toFixed(4)} · ${ev.duration_sec} с · токены: вход ${ev.cost.input_tokens + ev.cost.cache_write_tokens + ev.cost.cache_read_tokens}, выход ${ev.cost.output_tokens}`,
        ev.updated_at ? ` · ${new Date(ev.updated_at).toLocaleString()}` : '') : null,
      ev && ev.checklist_version !== cl.version ? h('div', { class: 'badge badge--warn' }, `оценено по версии v${ev.checklist_version} — переоцените`) : null
    );

    const sections = cl.sections.map((s) => {
      const crit = cl.criteria.filter((c) => c.section === s.id);
      if (!crit.length) return null;
      const sec = score.sections.find((x) => x.id === s.id);
      return h('div', { class: 'eval-section' },
        h('div', { class: 'eval-section__title' }, s.title, sec && sec.points != null ? ` · ${sec.points} / ${sec.max}` : ''),
        crit.map((c) => {
          const a = answers[c.id] || {};
          const r = rowById[c.id];
          const evidence = (a.evidence || []).map((i) => h('a', { href: msgLink(rec.conversation_id, i) }, `#${i}`));
          return h('div', { class: 'eval-crit' },
            h('div', { class: 'eval-crit__head' },
              h('span', null, c.title),
              h('span', null,
                h('span', { class: 'badge' + (a.value === NA ? ' badge--muted' : '') }, answerLabel(c, a.value)),
                r && r.points != null ? h('span', { class: 'small muted' }, ` ${roundTo(r.points, 2)} б.`) : null,
                h('span', { class: 'small muted' }, c.type === 'critical' ? ' · без баллов' : ` · вес ${c.weight}`)
              )
            ),
            h('div', { class: 'eval-crit__body' },
              a.explanation || (ev ? '' : c.description),
              a.quote ? h('blockquote', { class: 'eval-quote' }, a.quote) : null,
              evidence.length ? h('div', null, 'Основание: ', ...evidence.flatMap((e, i) => (i ? [', ', e] : [e]))) : null,
              a.checked_range ? h('div', null, 'Проверенный участок: ', h('a', { href: msgLink(rec.conversation_id, a.checked_range[0]) }, `#${a.checked_range[0]}–#${a.checked_range[1]}`)) : null,
              ev && a.value !== undefined ? h('button', { class: 'btn btn--sm btn--ghost', type: 'button', onclick: () => createAppeal(ev, c) }, 'Оспорить') : null
            )
          );
        })
      );
    });

    panel.replaceChildren(header, ...sections.filter(Boolean));
  }

  async function runEvaluation() {
    const rec = state.current;
    const cl = state.checklist;
    if (!state.checklists.some((c) => c.id === cl.id && c.version === cl.version)) {
      return setStatus('Сначала сохраните чек-лист — оценка выполняется по сохранённой версии', true);
    }
    const convId = rec.conversation_id;
    state.evaluating.add(convId);
    renderEvalPanel();
    setStatus(`Оценка ${convId} запущена…`);
    try {
      const ev = await api.evaluate({ group_id: state.groupId, conversation_id: convId, checklist_id: cl.id });
      const i = state.evaluations.findIndex((e) => e.id === ev.id);
      if (i >= 0) state.evaluations[i] = ev;
      else state.evaluations.push(ev);
      setStatus(`${convId}: ${ev.total ?? '—'} / 100 · $${ev.cost.usd.toFixed(4)}`);
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      state.evaluating.delete(convId);
      renderList();
      if (state.current && state.current.conversation_id === convId) renderEvalPanel();
    }
  }

  /* =====================================================================
   * 8. Апелляции
   * ===================================================================== */

  async function createAppeal(ev, criterion) {
    const comment = root.prompt(`Апелляция по критерию «${criterion.title}». Комментарий:`);
    if (!comment) return;
    const appeal = {
      id: `ap-${Date.now()}`,
      evaluation_id: ev.id,
      conversation_id: ev.conversation_id,
      group_id: ev.group_id,
      criterion_id: criterion.id,
      original_answer: ev.answers[criterion.id],
      comment,
      status: 'open', // open → confirmed | changed
      decision: null, // { value, reason, decided_at }
    };
    try {
      await api.put('appeals', appeal);
      state.appeals.push(appeal);
      setStatus('Апелляция сохранена');
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  async function renderAppeals() {
    try {
      state.appeals = await api.list('appeals');
    } catch (err) {
      setStatus(err.message, true);
    }
    const box = $('#appeals-list');
    if (!state.appeals.length) return box.replaceChildren(h('div', { class: 'empty' }, 'Апелляций пока нет'));
    box.replaceChildren(
      ...state.appeals.map((a) =>
        h('div', { class: 'appeal' },
          h('div', null,
            h('strong', null, a.conversation_id), ' · ', a.criterion_id, ' ',
            h('span', { class: 'badge' + (a.status === 'open' ? ' badge--warn' : '') }, a.status)
          ),
          h('div', { class: 'small muted' }, a.comment),
          h('a', { class: 'small', href: `#/conversations/${encodeURIComponent(a.conversation_id)}` }, 'Открыть диалог →')
        )
      )
    );
  }

  /* =====================================================================
   * 9. Редактор чек-листа
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

  function updateWeightSum() {
    const cl = state.checklist;
    const sum = cl.criteria.filter((c) => c.type !== 'critical').reduce((a, c) => a + (Number(c.weight) || 0), 0);
    const badge = $('#cl-weight-sum');
    badge.textContent = `Сумма весов: ${sum}`;
    badge.className = 'badge' + (sum === 100 ? '' : ' badge--warn');
    badge.title = sum === 100 ? '' : 'Итог всё равно нормируется к 100, но по правилам чек-листа сумма весов = 100';
  }

  function renderChecklistEditor() {
    const cl = state.checklist;
    if (!cl) return;

    $('#cl-select').replaceChildren(
      ...state.checklists.map((c) => h('option', { value: c.id, selected: c.id === cl.id }, `${c.name} (v${c.version})`))
    );
    $('#cl-name').value = cl.name;

    const tpl = $('#tpl-criterion');
    const nodes = cl.criteria.map((c, idx) => {
      const node = tpl.content.firstElementChild.cloneNode(true);
      const field = (name) => $(`[data-field="${name}"]`, node);

      field('section').replaceChildren(...cl.sections.map((s) => h('option', { value: s.id }, s.title)));
      for (const name of ['title', 'section', 'type', 'weight', 'description', 'na_condition']) field(name).value = c[name] ?? '';
      field('na_allowed').checked = Boolean(c.na_allowed);
      field('scale').value = scaleToText(c.scale);

      const sync = () => {
        $('.criterion__scale', node).hidden = c.type !== 'scale';
        field('na_condition').hidden = !c.na_allowed;
        field('weight').disabled = c.type === 'critical';
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
          if (c.type === 'critical') (c.weight = 0), (field('weight').value = 0);
          if (c.type === 'scale' && !(c.scale && c.scale.length)) {
            c.scale = [{ value: 10, label: 'Полностью' }, { value: 5, label: 'Частично' }, { value: 0, label: 'Нет' }];
            field('scale').value = scaleToText(c.scale);
          }
        }
        sync();
        updateWeightSum();
      });
      $('[data-action="remove"]', node).addEventListener('click', () => {
        cl.criteria.splice(idx, 1);
        renderChecklistEditor();
      });
      return node;
    });

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

  async function saveChecklist() {
    const cl = state.checklist;
    const errors = validateChecklist(cl);
    if (errors.length) return setStatus(errors.join('; '), true);
    try {
      const saved = await api.put('checklists', cl);
      const i = state.checklists.findIndex((c) => c.id === saved.id);
      if (i >= 0) state.checklists[i] = saved;
      else state.checklists.push(saved);
      state.checklist = saved;
      renderChecklistEditor();
      renderEvalPanel();
      setStatus(`Чек-лист «${saved.name}» сохранён`);
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  function bindChecklistToolbar() {
    $('#cl-select').addEventListener('change', (e) => {
      state.checklist = structuredClone(state.checklists.find((c) => c.id === e.target.value));
      renderChecklistEditor();
      renderEvalPanel();
    });
    $('#cl-name').addEventListener('input', (e) => (state.checklist.name = e.target.value));
    $('#cl-add').addEventListener('click', () => {
      const cl = state.checklist;
      let n = cl.criteria.length + 1;
      while (cl.criteria.some((c) => c.id === `c${String(n).padStart(2, '0')}`)) n++;
      cl.criteria.push({
        id: `c${String(n).padStart(2, '0')}`,
        section: cl.sections[0].id,
        title: 'Новый критерий',
        type: 'binary',
        weight: 10,
        na_allowed: false,
        description: '',
        na_condition: '',
      });
      renderChecklistEditor();
      $('#cl-criteria').lastElementChild.scrollIntoView({ behavior: 'smooth' });
    });
    $('#cl-copy').addEventListener('click', () => {
      const base = state.checklist;
      const version = Math.max(...state.checklists.map((c) => c.version || 1)) + 1;
      const copy = structuredClone(base);
      copy.id = `${base.id.replace(/-v\d+$/, '')}-v${version}`;
      copy.version = version;
      delete copy.created_at;
      delete copy.updated_at;
      state.checklist = copy;
      saveChecklist();
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
      setStatus(`Скачано ${r.saved} из ${r.total_records} диалогов → ${r.file}`);
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
      loadConversations();
    });
    $('#sync-btn').addEventListener('click', syncFromApi);
    ['#f-search', '#f-lang', '#f-channel'].forEach((s) => $(s).addEventListener('input', renderList));
    bindChecklistToolbar();

    try {
      const [checklists, evaluations] = await Promise.all([api.list('checklists'), api.list('evaluations')]);
      state.checklists = checklists;
      state.evaluations = evaluations;
      state.checklist = structuredClone(checklists[checklists.length - 1]);
    } catch (err) {
      setStatus(`Сервер недоступен: ${err.message}`, true);
    }

    await loadConversations();
    root.addEventListener('hashchange', onRoute);
    if (!location.hash) location.hash = '#/conversations';
    else onRoute();
  }

  // Публичное API модуля (удобно для отладки в консоли и будущей интеграции).
  root.CQA = { config: CONFIG, state, api, computeScore, NA };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
