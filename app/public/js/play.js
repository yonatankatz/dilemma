'use strict';
// Phone screen: join (profile for result breakdowns) -> two big buttons -> waiting screen.
(() => {
  const root = document.getElementById('root');
  const toastEl = document.getElementById('toast');
  const PROFILE_KEY = 'dilemma.profile.v1';

  let state = null;
  let localEndsAt = 0; // performance.now() timestamp when the vote countdown hits 0
  let currentKey = null;
  let currentEl = null;
  let joining = false;
  let draft = {};
  const optimistic = {}; // "gameId:index" -> choice, shown before the server confirms
  let rafId = 0;
  let es = null;

  // ---------- utils ----------
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

  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  async function post(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await r.json(); } catch {}
    return { ok: r.ok, data };
  }

  const segSignature = (segs) => JSON.stringify((segs || []).map((s) => [s.id, s.options]));
  function savedProfile(segs) {
    try {
      const saved = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
      if (!saved || saved.sig !== segSignature(segs)) return null;
      return saved.profile;
    } catch { return null; }
  }
  function saveProfile(segs, profile) {
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify({ sig: segSignature(segs), profile })); } catch {}
  }

  const remainingMs = () => Math.max(0, localEndsAt - performance.now());
  const myChoice = () => state.voted || optimistic[`${state.gameId}:${state.index}`] || null;

  // ---------- state -> screen ----------
  function screenKey() {
    if (!state) return 'loading';
    if (state.phase === 'idle') return 'nogame';
    if (!state.joined) return joining ? 'loading' : 'join';
    switch (state.phase) {
      case 'lobby': return 'wait:lobby';
      case 'vote': {
        const c = myChoice();
        if (c) return `wait:voted:${state.index}`;
        return remainingMs() > 0 ? `vote:${state.gameId}:${state.index}` : 'wait:timeup';
      }
      case 'guess': return 'wait:guess';
      case 'results': return 'wait:results';
      case 'end': return 'wait:end';
      default: return 'loading';
    }
  }

  function render() {
    const key = screenKey();
    if (key === currentKey) return;
    currentKey = key;
    cancelAnimationFrame(rafId);
    const el = build(key);
    if (currentEl) {
      const old = currentEl;
      old.classList.add('leaving');
      setTimeout(() => old.remove(), 260);
    }
    root.append(el);
    currentEl = el;
    if (key.startsWith('vote:')) runTimer(el);
  }

  function build(key) {
    const [kind, variant] = key.split(':');
    if (kind === 'vote') return buildVote();
    if (kind === 'join') return buildJoin();
    if (kind === 'nogame') {
      return waitScreen('⏳', 'עוד רגע מתחילים', 'המשחק עדיין לא נפתח. השאירו את המסך פתוח — הוא יתעדכן לבד.');
    }
    if (kind === 'loading') return h('div', { class: 'screen wait' }, h('div', { class: 'dots' }, h('i'), h('i'), h('i')));
    switch (variant) {
      case 'lobby': return waitScreen('🎉', 'אתם בפנים!', 'המשחק יתחיל בעוד רגע. כשתופיע דילמה — הכפתורים יופיעו כאן.');
      case 'voted': return votedScreen();
      case 'timeup': return waitScreen('⌛', 'הזמן נגמר', 'לא נורא — תוכלו להצביע בדילמה הבאה.');
      case 'guess': return waitScreen('🤔', 'מה לדעתכם הרוב בחרו?', 'הסתכלו על המסך הגדול ונחשו.');
      case 'results': return waitScreen('👀', 'התוצאות על המסך!', 'מחכים לדילמה הבאה…');
      case 'end': return waitScreen('🏆', 'המשחק נגמר', 'תודה ששיחקתם!', false);
      default: return waitScreen('⏳', '', '');
    }
  }

  function waitScreen(emoji, title, sub, dots = true) {
    return h('div', { class: 'screen wait' },
      h('div', { class: 'emoji' }, emoji),
      h('div', { class: 'big gold-text' }, title),
      h('div', { class: 'sub' }, sub),
      dots ? h('div', { class: 'dots' }, h('i'), h('i'), h('i')) : null);
  }

  // Deliberately does not reveal which option was chosen (people around can see the screen).
  function votedScreen() {
    return h('div', { class: 'screen wait' },
      h('div', { class: 'emoji' }, '✅'),
      h('div', { class: 'big gold-text' }, 'ההצבעה נקלטה!'),
      h('div', { class: 'sub' }, 'מחכים שכולם יצביעו…'),
      h('div', { class: 'dots' }, h('i'), h('i'), h('i')));
  }

  function buildVote() {
    const bar = h('i');
    const timer = h('div', { class: 'timer' }, bar);
    const el = h('div', { class: 'screen vote' },
      timer,
      h('button', { class: 'b1', 'aria-label': 'הצבעה 1', onclick: () => vote('1') }, h('span', {}, '1')),
      h('button', { class: 'b2', 'aria-label': 'הצבעה 2', onclick: () => vote('2') }, h('span', {}, '2')));
    el._bar = bar;
    el._timer = timer;
    return el;
  }

  function runTimer(el) {
    const total = (state.voteSeconds || 20) * 1000;
    const step = () => {
      const left = remainingMs();
      el._bar.style.transform = `scaleX(${Math.min(1, left / total)})`;
      el._timer.classList.toggle('urgent', left < 5000);
      if (left <= 0) return render();
      rafId = requestAnimationFrame(step);
    };
    step();
  }

  function buildJoin() {
    const segs = state.segments || [];
    const go = h('button', { class: 'btn go', onclick: () => doJoin(draft) }, 'יאללה, נכנסים!');
    const refresh = () => { go.disabled = !segs.every((s) => draft[s.id]); };
    const el = h('div', { class: 'screen join' },
      h('div', { class: 'emoji', style: 'font-size:3.2rem' }, '👋'),
      h('h1', { class: 'gold-text' }, 'לפני שמתחילים'),
      h('p', { class: 'note' }, 'אנונימי לגמרי — רק כדי להציג פילוח של התוצאות'),
      segs.map((seg, i) => {
        const box = h('div', { class: 'opts' });
        for (const opt of seg.options) {
          const b = h('button', {
            class: draft[seg.id] === opt ? 'on' : '',
            onclick: () => {
              draft[seg.id] = opt;
              box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
              if (navigator.vibrate) navigator.vibrate(15);
              refresh();
            },
          }, opt);
          box.append(b);
        }
        const wrap = h('div', { class: 'seg' }, h('h2', {}, seg.label), box);
        wrap.style.animationDelay = `${0.08 * i}s`;
        return wrap;
      }),
      go);
    refresh();
    return el;
  }

  async function doJoin(profile) {
    if (joining) return;
    joining = true;
    render();
    try {
      const { ok, data } = await post('/api/join', { profile });
      if (ok) {
        saveProfile(state.segments, profile);
        apply(data.state);
      } else {
        toast('לא הצלחנו להצטרף, נסו שוב');
      }
    } catch {
      toast('בעיית חיבור, נסו שוב');
    } finally {
      joining = false;
      render();
    }
  }

  let voting = false;
  async function vote(choice) {
    if (voting || myChoice()) return;
    voting = true;
    const key = `${state.gameId}:${state.index}`;
    const index = state.index;
    optimistic[key] = choice;
    if (navigator.vibrate) navigator.vibrate(40);
    render();
    try {
      const { ok, data } = await post('/api/vote', { choice, index });
      if (!ok) {
        if (data.error === 'already_voted') optimistic[key] = data.choice;
        else {
          delete optimistic[key];
          if (data.error === 'not_joined') state.joined = false;
          toast(data.error === 'not_voting' || data.error === 'wrong_dilemma' ? 'ההצבעה כבר נסגרה' : 'משהו השתבש, נסו שוב');
        }
      }
    } catch {
      delete optimistic[key];
      toast('בעיית חיבור, נסו שוב');
    } finally {
      voting = false;
      render();
    }
  }

  // ---------- server sync ----------
  function apply(next) {
    if (!next) return;
    state = next;
    localEndsAt = performance.now() + (next.remainingMs || 0);
    // First time in this game with a remembered profile -> join automatically.
    if (state.phase !== 'idle' && !state.joined && !joining) {
      const segs = state.segments || [];
      const saved = savedProfile(segs);
      if (!segs.length) doJoin({});
      else if (saved && segs.every((s) => saved[s.id])) doJoin(saved);
      else if (!Object.keys(draft).length && saved) draft = { ...saved };
    }
    render();
  }

  function connect() {
    if (es) es.close();
    es = new EventSource('/api/events');
    es.onmessage = (e) => apply(JSON.parse(e.data));
  }

  // Phones drop connections when the screen locks; resync when we come back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!es || es.readyState === EventSource.CLOSED) connect();
    fetch('/api/state', { credentials: 'same-origin' }).then((r) => r.json()).then(apply).catch(() => {});
  });

  render();
  connect();
})();
