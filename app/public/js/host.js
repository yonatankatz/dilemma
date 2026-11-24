'use strict';
// Big screen that runs the game. State comes from /admin/api/events (SSE);
// the host advances phases with the "next" button / Space / Enter / ← / PageDown.
(() => {
  const S = window.GameSound;
  const stage = document.getElementById('stage');
  const nextBtn = document.getElementById('next');
  const progressChip = document.getElementById('progress');
  const peopleChip = document.getElementById('people');
  const muteBtn = document.getElementById('mute');

  let st = null;
  let localEndsAt = 0;
  let currentKey = null;
  let screen = null; // { el, update?(st), destroy?() }
  let unlocked = false;
  let busy = false;

  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c != null) el.append(c);
    return el;
  };
  const restartAnim = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const joinUrl = () => `${location.origin}/`;

  /** Shrinks font-size until the text fits its box. */
  function fitText(el, maxPx, minPx = 18) {
    let size = maxPx;
    el.style.fontSize = `${size}px`;
    while (size > minPx && (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2)) {
      size -= 2;
      el.style.fontSize = `${size}px`;
    }
  }
  const unit = () => Math.min(window.innerWidth / 100, window.innerHeight / 56.25);

  function qrSvg(text) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let path = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`;
    return `<svg viewBox="-1 -1 ${n + 2} ${n + 2}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges"><path d="${path}" fill="#2a0610"/></svg>`;
  }

  function optionCards(d) {
    return h('div', { class: 'options' },
      h('div', { class: 'opt' }, h('span', { class: 'badge o1' }, '1'), h('span', {}, d.option1)),
      h('div', { class: 'opt' }, h('span', { class: 'badge o2' }, '2'), h('span', {}, d.option2)));
  }

  function splitBar(pct, showLabels = true) {
    const s1 = h('div', { class: 's1' }, showLabels && pct['1'] >= 12 ? `${pct['1']}%` : '');
    const s2 = h('div', { class: 's2' }, showLabels && pct['2'] >= 12 ? `${pct['2']}%` : '');
    const bar = h('div', { class: 'split-bar' }, s1, s2);
    bar._set = () => { s1.style.width = `${pct['1']}%`; s2.style.width = `${pct['2']}%`; };
    return bar;
  }

  // ======================= screens =======================

  function idleScreen() {
    const el = h('div', { class: 'screen' },
      h('h1', { class: 'title gold-text' }, 'מה הייתם עושים?'),
      h('p', { class: 'subtitle' }, 'אין משחק פעיל כרגע'),
      h('div', { style: 'margin-top:calc(var(--u)*5)' },
        h('button', { class: 'btn', style: 'font-size:calc(var(--u)*3)', onclick: newGame }, 'פתיחת משחק חדש')));
    return { el };
  }

  function lobbyScreen() {
    const n = h('span', { class: 'n gold-text' }, String(st.participants));
    const qr = h('div', { class: 'qr-card' }, h('div', { class: 'scan' }, 'סרקו כדי להצטרף'));
    qr.insertAdjacentHTML('beforeend', qrSvg(joinUrl()));
    qr.append(h('div', { class: 'url' }, joinUrl().replace(/^https?:\/\//, '').replace(/\/$/, '')));
    const el = h('div', { class: 'screen lobby' },
      h('div', { class: 'info' },
        h('h1', { class: 'title gold-text' }, 'מה הייתם עושים?'),
        h('p', { class: 'subtitle' }, 'מצביעים מהטלפון, ומנחשים מה הרוב בחרו'),
        h('div', { class: 'counter' }, n, h('div', { class: 'label' }, 'משתתפים מחוברים'))),
      qr);
    let last = st.participants;
    return {
      el,
      update(s) {
        if (s.participants !== last) {
          if (s.participants > last) S.blip();
          last = s.participants;
          n.textContent = String(last);
          restartAnim(n, 'bump');
        }
      },
    };
  }

  function voteScreen() {
    const d = st.dilemma;
    const R = 52;
    const C = 2 * Math.PI * R;
    const ring = h('div', { class: 'ring' });
    ring.innerHTML = `<svg viewBox="0 0 120 120"><circle class="track" cx="60" cy="60" r="${R}"/><circle class="bar" cx="60" cy="60" r="${R}" stroke-dasharray="${C}" stroke-dashoffset="0"/></svg>`;
    const num = h('div', { class: 'num' }, String(st.voteSeconds));
    ring.append(num);
    const bar = ring.querySelector('.bar');
    const votedN = h('span', { class: 'n gold-text' }, String(st.votedCount));
    const votedOf = h('div', { class: 'label' }, `מתוך ${st.participants} הצביעו`);
    const text = h('div', { class: 'dilemma-text' }, h('span', {}, d.text));

    const el = h('div', { class: 'screen vote' },
      h('div', { class: 'head' }, h('div', { class: 'spacer' }), ring, h('div', { class: 'voted' }, votedN, votedOf)),
      text,
      optionCards(d));

    requestAnimationFrame(() => fitText(text, unit() * 6, unit() * 2.6));

    const total = st.voteSeconds * 1000;
    let lastSec = null;
    let raf = 0;
    let done = false;
    const frame = () => {
      const left = Math.max(0, localEndsAt - performance.now());
      bar.setAttribute('stroke-dashoffset', String(C * (1 - left / total)));
      const sec = Math.ceil(left / 1000);
      if (sec !== lastSec) {
        lastSec = sec;
        num.textContent = String(sec);
        restartAnim(num, 'tickpop');
        if (sec > 0) S.tick(sec <= 5);
      }
      ring.classList.toggle('urgent', left > 0 && left <= 5000);
      S.setIntensity(left < 6000 ? (6000 - left) / 6000 : 0);
      if (left <= 0 && !done) {
        done = true;
        ring.classList.remove('urgent');
        ring.append(h('div', { class: 'stamp' }, 'הזמן', h('br'), 'נגמר!'));
        S.setMode(null);
        S.buzzer();
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    frame();

    let lastVoted = st.votedCount;
    return {
      el,
      update(s) {
        votedOf.textContent = `מתוך ${s.participants} הצביעו`;
        if (s.votedCount !== lastVoted) {
          if (s.votedCount > lastVoted) S.blip();
          lastVoted = s.votedCount;
          votedN.textContent = String(lastVoted);
          restartAnim(votedN, 'bump');
        }
      },
      destroy() { cancelAnimationFrame(raf); },
    };
  }

  function guessScreen() {
    const marks = h('div', { class: 'qmarks' });
    for (let i = 0; i < 18; i++) {
      const size = 4 + Math.random() * 10;
      marks.append(h('span', {
        style: `left:${Math.random() * 100}%;font-size:calc(var(--u)*${size});animation-duration:${8 + Math.random() * 10}s;animation-delay:${-Math.random() * 14}s`,
      }, '?'));
    }
    const el = h('div', { class: 'screen guess' },
      marks,
      h('h1', { class: 'title gold-text' }, 'מה לדעתכם האחרים חשבו?'),
      optionCards(st.dilemma));
    return { el };
  }

  function resultsScreen(fresh) {
    const d = st.dilemma;
    const r = st.results;
    const el = h('div', { class: 'screen results' }, h('div', { class: 'q' }, d.text));
    if (!r || !r.total) {
      el.append(h('div', { class: 'empty' },
        h('div', { class: 'title gold-text' }, 'אף אחד לא הצביע 🤷'),
        h('p', { class: 'subtitle' }, 'ממשיכים לדילמה הבאה')));
      if (fresh) S.setMode('results');
      return { el };
    }

    const bars = h('div', { class: 'bars' });
    const parts = ['1', '2'].map((k) => {
      const pct = h('div', { class: 'pct' }, '0%');
      const cnt = h('span', { class: 'cnt' });
      const fill = h('div', { class: 'fill' });
      const crown = h('span', { class: 'crown', hidden: '' }, r.majority === 'tie' ? 'תיקו!' : '👑 הרוב בחרו');
      const row = h('div', { class: `orow o${k}` },
        h('div', { class: 'ohead' },
          h('span', { class: `badge o${k}` }, k),
          h('span', { class: 'otext' }, k === '1' ? d.option1 : d.option2)),
        h('div', { class: 'bar-line' }, h('div', { class: 'track' }, fill), h('div', { class: 'pct-box' }, crown, pct, cnt)));
      bars.append(row);
      return { k, row, pct, cnt, fill, crown };
    });

    const bd = h('div', { class: 'breakdown' });
    const bdInner = h('div', { class: 'bd-inner' });
    for (const seg of r.breakdown) {
      const block = h('div', {}, h('h3', {}, `פילוח לפי ${seg.label}`));
      for (const g of seg.groups) {
        const sb = splitBar(g.pct);
        block.append(h('div', { class: 'brow' }, h('div', { class: 'g' }, g.value), sb, h('div', { class: 'n' }, `${g.total} מצביעים`)));
      }
      bdInner.append(block);
    }
    bd.append(bdInner);
    el.append(h('div', { class: 'body' }, bars, bd));
    // Shrink the breakdown font until every group fits the available height.
    requestAnimationFrame(() => {
      let size = unit() * 2.4;
      bdInner.style.fontSize = `${size}px`;
      while (size > 10 && bdInner.scrollHeight > bd.clientHeight) {
        size -= 1;
        bdInner.style.fontSize = `${size}px`;
      }
    });

    const setFinal = () => {
      for (const p of parts) {
        p.pct.textContent = `${r.pct[p.k]}%`;
        p.cnt.textContent = `${r.counts[p.k]} קולות`;
        p.fill.style.width = `${Math.max(r.pct[p.k], 1)}%`;
      }
    };
    const crownUp = () => {
      for (const p of parts) {
        if (r.majority === 'tie' || r.majority === p.k) {
          p.crown.hidden = false;
          p.row.classList.add('win');
        } else {
          p.row.classList.add('lose');
        }
      }
    };
    const openBreakdown = () => {
      if (!r.breakdown.length) return;
      el.classList.add('split');
      setTimeout(() => {
        bd.querySelectorAll('.split-bar').forEach((b, i) => setTimeout(() => b._set(), i * 120));
      }, 500);
    };

    let cancelled = false;
    if (!fresh) {
      setFinal();
      crownUp();
      openBreakdown();
      S.setMode('results');
    } else {
      (async () => {
        await wait(700);
        if (cancelled) return;
        const DUR = 3200;
        S.drumroll(DUR / 1000);
        const t0 = performance.now();
        // Suspense: bars climb slowly together, with a tiny wobble, then settle on the real values.
        await new Promise((resolve) => {
          const frame = () => {
            if (cancelled) return resolve();
            const p = Math.min(1, (performance.now() - t0) / DUR);
            const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
            for (const [i, part] of parts.entries()) {
              const target = r.pct[part.k];
              const wobble = (1 - p) * Math.sin(p * 18 + i * 2) * 6;
              const v = Math.max(0, target * e + wobble * e);
              part.fill.style.width = `${Math.max(v, 1)}%`;
              part.pct.textContent = `${Math.round(Math.max(0, Math.min(100, v)))}%`;
            }
            if (p < 1) requestAnimationFrame(frame);
            else resolve();
          };
          requestAnimationFrame(frame);
        });
        if (cancelled) return;
        setFinal();
        S.reveal();
        crownUp();
        setTimeout(() => !cancelled && S.setMode('results'), 900);
        await wait(st.breakdownDelaySeconds * 1000);
        if (cancelled) return;
        if (r.breakdown.length) S.whoosh();
        openBreakdown();
      })();
    }
    return { el, destroy() { cancelled = true; } };
  }

  function endScreen(fresh) {
    const summary = h('div', { class: 'summary' });
    (st.summary || []).forEach((s, i) => {
      const sb = splitBar(s.pct);
      const row = h('div', { class: 'srow', style: `animation-delay:${0.6 + i * 0.12}s` },
        h('div', { class: 't' }, h('b', { class: 'gold-text' }, String(i + 1)), '  ', s.text),
        s.total ? sb : h('div', { class: 'n' }, 'אין הצבעות'));
      summary.append(row);
      setTimeout(() => sb._set(), 900 + i * 120);
    });
    const el = h('div', { class: 'screen end' },
      h('h1', { class: 'title gold-text' }, 'המשחק הסתיים!'),
      h('p', { class: 'subtitle' }, 'תודה ששיחקתם 💛'),
      summary);
    let confetti = null;
    if (fresh) {
      confetti = h('div', { class: 'confetti' });
      const colors = ['#f7d77a', '#e8b64c', '#c8102e', '#f6e8cc', '#e8344f'];
      for (let i = 0; i < 140; i++) {
        confetti.append(h('i', {
          style: `left:${Math.random() * 100}%;background:${colors[i % colors.length]};animation-duration:${2.5 + Math.random() * 3.5}s;animation-delay:${Math.random() * 1.8}s;border-radius:${Math.random() > 0.5 ? '50%' : '2px'}`,
        }));
      }
      document.body.append(confetti);
      setTimeout(() => confetti && confetti.remove(), 9000);
      S.fanfare();
    }
    S.setMode('end');
    return { el, destroy() { if (confetti) confetti.remove(); } };
  }

  // ======================= rendering =======================

  function keyOf(s) {
    return `${s.gameId}:${s.phase}:${s.index}`;
  }

  function build(s) {
    // "fresh" = we're watching the transition live (not reloading the page mid-phase)
    const fresh = s.phaseAgeMs < 2500;
    switch (s.phase) {
      case 'idle': S.setMode('lobby'); return idleScreen();
      case 'lobby': S.setMode('lobby'); return lobbyScreen();
      case 'vote': S.setMode('vote'); return voteScreen();
      case 'guess': S.setMode('guess'); return guessScreen();
      case 'results': return resultsScreen(fresh);
      case 'end': return endScreen(fresh);
      default: return idleScreen();
    }
  }

  function render() {
    const key = keyOf(st);
    if (key !== currentKey) {
      const first = currentKey === null;
      currentKey = key;
      if (screen) {
        const old = screen;
        if (old.destroy) old.destroy();
        old.el.classList.add('leaving');
        setTimeout(() => old.el.remove(), 550);
        if (unlocked) S.whoosh();
      }
      screen = build(st);
      stage.append(screen.el);
      if (first && !unlocked) S.setMode(null);
    } else if (screen && screen.update) {
      screen.update(st);
    }
    renderHud();
  }

  const NEXT_LABEL = {
    lobby: '▶ התחלת המשחק',
    vote: '⏭ סיום ההצבעה',
    guess: '✨ הצגת התוצאות',
  };

  function renderHud() {
    const inGame = st.phase !== 'idle';
    progressChip.hidden = !(st.index >= 0 && st.phase !== 'end');
    progressChip.textContent = `דילמה ${st.index + 1} מתוך ${st.total}`;
    peopleChip.hidden = !inGame || st.phase === 'lobby';
    peopleChip.textContent = `👥 ${st.participants}`;

    let label = NEXT_LABEL[st.phase];
    if (st.phase === 'results') label = st.index + 1 < st.total ? '⏩ לדילמה הבאה' : '🏁 סיום המשחק';
    nextBtn.hidden = !label;
    if (label) nextBtn.textContent = label;
  }

  // ======================= actions =======================

  async function api(path, body = {}) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    if (data.game) apply(data.game);
    return { ok: r.ok, data };
  }

  async function next() {
    if (!st || busy || nextBtn.hidden) return;
    busy = true;
    nextBtn.disabled = true;
    try {
      await api('/admin/api/game/next', { expected: { phase: st.phase, index: st.index } });
    } finally {
      setTimeout(() => { busy = false; nextBtn.disabled = false; }, 700);
    }
  }

  async function newGame() {
    const { ok, data } = await api('/admin/api/game/new');
    if (!ok) alert(data.error === 'no_dilemmas' ? 'אין דילמות פעילות — הוסיפו דילמות בעמוד הניהול' : 'שגיאה ביצירת משחק');
  }

  function apply(view) {
    st = view;
    localEndsAt = performance.now() + (view.remainingMs || 0);
    render();
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }

  function unlock(fullscreen) {
    if (unlocked) return;
    unlocked = true;
    S.init();
    if (fullscreen) toggleFullscreen();
    document.getElementById('unlock').classList.add('hide');
    setTimeout(() => document.getElementById('unlock').remove(), 500);
    // Start music for the current phase
    if (st) {
      const m = { idle: 'lobby', lobby: 'lobby', vote: 'vote', guess: 'guess', results: 'results', end: 'end' }[st.phase];
      S.setMode(m);
    }
  }

  document.getElementById('startFs').addEventListener('click', () => unlock(true));
  document.getElementById('startWin').addEventListener('click', () => unlock(false));
  nextBtn.addEventListener('click', next);
  document.getElementById('fs').addEventListener('click', toggleFullscreen);
  muteBtn.addEventListener('click', () => { muteBtn.textContent = S.toggleMute() ? '🔇' : '🔊'; });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea')) return;
    if (!unlocked) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); unlock(true); }
      return;
    }
    if ([' ', 'Enter', 'ArrowLeft', 'PageDown'].includes(e.key)) { e.preventDefault(); next(); }
    else if (e.key === 'm' || e.key === 'M') muteBtn.click();
    else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  });

  // Keep the QR / text fitting when the window is resized (e.g. entering fullscreen)
  window.addEventListener('resize', () => {
    const t = stage.querySelector('.screen:not(.leaving) .dilemma-text');
    if (t) fitText(t, unit() * 6.2, unit() * 2.6);
  });

  const es = new EventSource('/admin/api/events');
  es.onmessage = (e) => apply(JSON.parse(e.data));
})();
