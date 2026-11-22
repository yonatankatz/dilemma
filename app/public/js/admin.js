'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) el.append(c);
    return el;
  };

  let dilemmas = [];
  let editingId = null;

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }
  function flash(id) {
    const el = $(id);
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 1500);
  }

  async function api(method, path, body) {
    const r = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }

  // ---------- game status ----------
  const PHASE_NAMES = { idle: 'אין משחק', lobby: 'לובי — ממתינים למשתתפים', vote: 'הצבעה', guess: 'ניחוש', results: 'תוצאות', end: 'הסתיים' };

  function renderGame(g) {
    const s = $('status');
    s.replaceChildren(...[
      h('span', { class: 'pill' }, 'מצב: ', h('b', {}, PHASE_NAMES[g.phase] || g.phase)),
      g.phase !== 'idle' ? h('span', { class: 'pill' }, 'משתתפים: ', h('b', {}, String(g.participants))) : null,
      g.index >= 0 ? h('span', { class: 'pill' }, 'דילמה: ', h('b', {}, `${g.index + 1}/${g.total}`)) : null,
      g.phase === 'vote' ? h('span', { class: 'pill' }, 'הצביעו: ', h('b', {}, String(g.votedCount))) : null].filter(Boolean));
    $('endGame').disabled = g.phase === 'idle' || g.phase === 'end';
    $('csv').style.display = g.phase === 'idle' ? 'none' : '';
  }

  function renderQr() {
    const url = `${location.origin}/`;
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    const n = qr.getModuleCount();
    let path = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`;
    $('qr').innerHTML = `<svg viewBox="-1 -1 ${n + 2} ${n + 2}" shape-rendering="crispEdges"><path d="${path}" fill="#2a0610"/></svg>`;
    $('qr').append(h('a', { href: url, target: '_blank' }, url.replace(/^https?:\/\//, '')));
  }

  $('newGame').addEventListener('click', async () => {
    const status = $('status').textContent;
    if (!/אין משחק|הסתיים/.test(status) && !confirm('יש משחק פעיל. לפתוח משחק חדש? (התוצאות של הנוכחי נשמרות בארכיון)')) return;
    try {
      const r = await api('POST', '/admin/api/game/new', {});
      renderGame(r.game);
      toast('נפתח משחק חדש — פתחו את מסך המשחק');
    } catch (e) {
      toast(e.message === 'no_dilemmas' ? 'אין דילמות פעילות' : `שגיאה: ${e.message}`);
    }
  });
  $('endGame').addEventListener('click', async () => {
    if (!confirm('לסיים את המשחק עכשיו?')) return;
    const r = await api('POST', '/admin/api/game/end', {});
    renderGame(r.game);
  });

  // ---------- dilemmas ----------
  async function saveDilemmas(next) {
    try {
      dilemmas = await api('PUT', '/admin/api/dilemmas', next);
      flash('dsaved');
    } catch (e) {
      toast(`שמירה נכשלה: ${e.message}`);
    }
    renderList();
  }

  function renderList() {
    const active = dilemmas.filter((d) => d.active).length;
    $('dcount').textContent = `(${active} פעילות מתוך ${dilemmas.length})`;
    const list = $('list');
    list.replaceChildren();
    if (!dilemmas.length) list.append(h('p', { class: 'hint' }, 'אין עדיין דילמות. הוסיפו אחת למטה.'));
    dilemmas.forEach((d, i) => {
      if (d.id === editingId) return list.append(editForm(d));
      const move = (delta) => {
        const next = dilemmas.slice();
        const [x] = next.splice(i, 1);
        next.splice(i + delta, 0, x);
        saveDilemmas(next);
      };
      list.append(h('div', { class: `item${d.active ? '' : ' off'}` },
        h('div', { class: 'idx' }, String(i + 1)),
        h('div', {},
          h('div', { class: 'text' }, d.text),
          h('div', { class: 'opts' },
            h('span', {}, h('span', { class: 'badge o1' }, '1'), d.option1),
            h('span', {}, h('span', { class: 'badge o2' }, '2'), d.option2))),
        h('div', { class: 'tools' },
          h('button', { class: 'tool', title: 'למעלה', disabled: i === 0, onclick: () => move(-1) }, '↑'),
          h('button', { class: 'tool', title: 'למטה', disabled: i === dilemmas.length - 1, onclick: () => move(1) }, '↓'),
          h('button', {
            class: 'tool', title: d.active ? 'השבתה (לא ייכלל במשחק)' : 'הפעלה',
            onclick: () => saveDilemmas(dilemmas.map((x) => (x.id === d.id ? { ...x, active: !x.active } : x))),
          }, d.active ? '👁' : '🚫'),
          h('button', { class: 'tool', title: 'עריכה', onclick: () => { editingId = d.id; renderList(); } }, '✎'),
          h('button', {
            class: 'tool', title: 'מחיקה',
            onclick: () => confirm('למחוק את הדילמה?') && saveDilemmas(dilemmas.filter((x) => x.id !== d.id)),
          }, '🗑'))));
    });
  }

  function editForm(d) {
    const text = h('textarea', { required: true, maxlength: 600 });
    text.value = d.text;
    const o1 = h('input', { required: true, maxlength: 120 });
    o1.value = d.option1;
    const o2 = h('input', { required: true, maxlength: 120 });
    o2.value = d.option2;
    const form = h('form', { class: 'edit item', style: 'display:grid;grid-template-columns:1fr' },
      h('label', {}, 'הדילמה', text),
      h('div', { class: 'row2' }, h('label', {}, 'אפשרות 1', o1), h('label', {}, 'אפשרות 2', o2)),
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn', type: 'submit' }, 'שמירה'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { editingId = null; renderList(); } }, 'ביטול')));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      editingId = null;
      saveDilemmas(dilemmas.map((x) => (x.id === d.id ? { ...x, text: text.value, option1: o1.value, option2: o2.value } : x)));
    });
    setTimeout(() => text.focus(), 0);
    return form;
  }

  $('addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    await saveDilemmas([...dilemmas, { text: f.text.value, option1: f.option1.value, option2: f.option2.value, active: true }]);
    f.reset();
    f.text.focus();
  });

  $('bulkAdd').addEventListener('click', async () => {
    const lines = $('bulk').value.split('\n').map((l) => l.trim()).filter(Boolean);
    const added = [];
    for (const [i, line] of lines.entries()) {
      const parts = line.split('|').map((p) => p.trim());
      if (parts.length !== 3 || parts.some((p) => !p)) {
        $('bulkErr').textContent = `שורה ${i + 1} לא בפורמט הנכון`;
        return;
      }
      added.push({ text: parts[0], option1: parts[1], option2: parts[2], active: true });
    }
    $('bulkErr').textContent = '';
    if (!added.length) return;
    await saveDilemmas([...dilemmas, ...added]);
    $('bulk').value = '';
    toast(`נוספו ${added.length} דילמות`);
  });

  // ---------- settings ----------
  function segRow(seg = { label: '', options: [] }) {
    const label = h('input', { placeholder: 'למשל: גיל', maxlength: 40 });
    label.value = seg.label;
    const opts = h('input', { placeholder: 'מתחת ל-60, 60 ומעלה' });
    opts.value = seg.options.join(', ');
    const row = h('div', { class: 'seg-row' },
      h('label', {}, 'כותרת', label),
      h('label', {}, 'אפשרויות', opts),
      h('button', { class: 'tool', type: 'button', title: 'הסרה', onclick: () => row.remove() }, '🗑'));
    row._get = () => ({ id: seg.id, label: label.value, options: opts.value.split(/[,،]/).map((s) => s.trim()).filter(Boolean) });
    return row;
  }

  function renderSettings(s) {
    const f = $('settingsForm');
    f.voteSeconds.value = s.voteSeconds;
    f.breakdownDelaySeconds.value = s.breakdownDelaySeconds;
    $('segs').replaceChildren(...s.segments.map(segRow));
  }

  $('addSeg').addEventListener('click', () => $('segs').append(segRow()));
  $('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const s = await api('PUT', '/admin/api/settings', {
        voteSeconds: Number(f.voteSeconds.value),
        breakdownDelaySeconds: Number(f.breakdownDelaySeconds.value),
        segments: [...$('segs').children].map((r) => r._get()),
      });
      $('settingsErr').textContent = '';
      renderSettings(s);
      flash('ssaved');
    } catch (err) {
      $('settingsErr').textContent = err.message;
    }
  });

  // ---------- boot ----------
  renderQr();
  api('GET', '/admin/api/dilemmas').then((d) => { dilemmas = d; renderList(); });
  api('GET', '/admin/api/settings').then(renderSettings);
  const es = new EventSource('/admin/api/events');
  es.onmessage = (e) => renderGame(JSON.parse(e.data));
})();
