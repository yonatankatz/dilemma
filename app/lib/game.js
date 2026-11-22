'use strict';
// Game state machine. Pure logic + an injectable clock so it is unit-testable.
//
// Phases:  idle -> lobby -> vote -> guess -> results -> (vote of next dilemma | end)
//   idle    : no game exists
//   lobby   : QR code shown, phones join
//   vote    : dilemma shown, countdown running, phones vote 1/2 (once per dilemma)
//   guess   : static "what do you think the others chose?" screen
//   results : animated results + breakdown by participant segments
//   end     : all dilemmas done
const crypto = require('node:crypto');

const CHOICES = ['1', '2'];
// Votes are still accepted this long after the countdown hits 0 (network latency),
// then the game auto-advances to the guess phase.
const VOTE_GRACE_MS = 1200;

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function split(counts) {
  const total = counts['1'] + counts['2'];
  if (!total) return { '1': 0, '2': 0 };
  const p1 = Math.round((counts['1'] / total) * 100);
  return { '1': p1, '2': 100 - p1 };
}

function computeResults(votes, participants, segments) {
  const counts = { '1': 0, '2': 0 };
  for (const c of Object.values(votes)) if (c in counts) counts[c]++;
  const total = counts['1'] + counts['2'];
  let majority = null;
  if (total) majority = counts['1'] === counts['2'] ? 'tie' : counts['1'] > counts['2'] ? '1' : '2';

  const breakdown = (segments || [])
    .map((seg) => {
      const groups = seg.options
        .map((value) => {
          const c = { '1': 0, '2': 0 };
          for (const [pid, choice] of Object.entries(votes)) {
            const profile = participants[pid] && participants[pid].profile;
            if (profile && profile[seg.id] === value && choice in c) c[choice]++;
          }
          return { value, total: c['1'] + c['2'], counts: c, pct: split(c) };
        })
        .filter((g) => g.total > 0);
      return { id: seg.id, label: seg.label, groups };
    })
    .filter((s) => s.groups.length > 0);

  return { counts, total, pct: split(counts), majority, breakdown };
}

function emptyState() {
  return {
    id: null,
    phase: 'idle',
    index: -1,
    dilemmas: [],
    settings: { voteSeconds: 20, breakdownDelaySeconds: 3, segments: [] },
    participants: {},
    votes: [],
    createdAt: 0,
    phaseStartedAt: 0,
    phaseEndsAt: 0,
  };
}

class Game {
  /**
   * @param {object} opts
   * @param {object} [opts.initial]  persisted state to restore
   * @param {() => number} [opts.now]
   * @param {(scope: 'all'|'hosts') => void} [opts.onChange]  'hosts' = only host screens care
   */
  constructor({ initial, now = Date.now, onChange = () => {} } = {}) {
    this.now = now;
    this.onChange = onChange;
    this.s = initial && initial.phase ? initial : emptyState();
  }

  get state() {
    return this.s;
  }

  _setPhase(phase) {
    const s = this.s;
    const t = this.now();
    s.phase = phase;
    s.phaseStartedAt = t;
    s.phaseEndsAt = phase === 'vote' ? t + s.settings.voteSeconds * 1000 : 0;
    this.onChange('all');
  }

  newGame(dilemmas, settings) {
    if (!dilemmas || !dilemmas.length) return { error: 'no_dilemmas' };
    const t = this.now();
    this.s = {
      id: newId(),
      phase: 'lobby',
      index: -1,
      dilemmas: dilemmas.map(({ id, text, option1, option2 }) => ({ id, text, option1, option2 })),
      settings: {
        voteSeconds: settings.voteSeconds,
        breakdownDelaySeconds: settings.breakdownDelaySeconds,
        segments: JSON.parse(JSON.stringify(settings.segments || [])),
      },
      participants: {},
      votes: dilemmas.map(() => ({})),
      createdAt: t,
      phaseStartedAt: t,
      phaseEndsAt: 0,
    };
    this.onChange('all');
    return { ok: true, id: this.s.id };
  }

  /** Register a phone. Profile values not matching the configured segments are dropped. */
  join(pid, profile) {
    const s = this.s;
    if (s.phase === 'idle') return { error: 'no_game' };
    const clean = {};
    for (const seg of s.settings.segments) {
      const v = profile && profile[seg.id];
      if (typeof v === 'string' && seg.options.includes(v)) clean[seg.id] = v;
    }
    const existing = s.participants[pid];
    s.participants[pid] = { profile: clean, joinedAt: existing ? existing.joinedAt : this.now() };
    this.onChange('hosts'); // phones don't display participant counts
    return { ok: true };
  }

  vote(pid, choice, index) {
    const s = this.s;
    choice = String(choice);
    if (s.phase !== 'vote') return { error: 'not_voting' };
    if (index !== undefined && index !== null && Number(index) !== s.index) return { error: 'wrong_dilemma' };
    if (!s.participants[pid]) return { error: 'not_joined' };
    if (!CHOICES.includes(choice)) return { error: 'invalid_choice' };
    const votes = s.votes[s.index];
    if (votes[pid]) return { error: 'already_voted', choice: votes[pid] };
    votes[pid] = choice;
    this.onChange('hosts');
    return { ok: true, choice };
  }

  /**
   * Host "advance" button. `expected` ({phase, index}) guards against double clicks /
   * two host screens advancing twice.
   */
  next(expected) {
    const s = this.s;
    if (expected && (expected.phase !== s.phase || Number(expected.index) !== s.index)) return { error: 'stale' };
    switch (s.phase) {
      case 'lobby':
        s.index = 0;
        this._setPhase('vote');
        break;
      case 'vote':
        this._setPhase('guess');
        break;
      case 'guess':
        this._setPhase('results');
        break;
      case 'results':
        if (s.index + 1 < s.dilemmas.length) {
          s.index += 1;
          this._setPhase('vote');
        } else {
          this._setPhase('end');
        }
        break;
      default:
        return { error: 'cannot_advance' };
    }
    return { ok: true };
  }

  end() {
    if (this.s.phase === 'idle' || this.s.phase === 'end') return { ok: true };
    this._setPhase('end');
    return { ok: true };
  }

  /** Called periodically; auto-advances when the vote countdown (plus grace) expired. */
  tick() {
    const s = this.s;
    if (s.phase === 'vote' && this.now() >= s.phaseEndsAt + VOTE_GRACE_MS) {
      this._setPhase('guess');
      return true;
    }
    return false;
  }

  results(index) {
    const s = this.s;
    return computeResults(s.votes[index] || {}, s.participants, s.settings.segments);
  }

  _remainingMs() {
    const s = this.s;
    return s.phase === 'vote' ? Math.max(0, s.phaseEndsAt - this.now()) : 0;
  }

  /** What a phone sees. Never includes other people's votes or dilemma texts. */
  publicView(pid) {
    const s = this.s;
    const joined = !!s.participants[pid];
    const current = s.index >= 0 && s.votes[s.index] ? s.votes[s.index] : {};
    return {
      gameId: s.id,
      phase: s.phase,
      index: s.index,
      total: s.dilemmas.length,
      remainingMs: this._remainingMs(),
      voteSeconds: s.settings.voteSeconds,
      joined,
      voted: (s.phase === 'vote' || s.phase === 'guess' || s.phase === 'results') && current[pid] ? current[pid] : null,
      segments: s.settings.segments,
    };
  }

  /** What the big screen / admin sees. */
  hostView() {
    const s = this.s;
    const d = s.index >= 0 ? s.dilemmas[s.index] : null;
    const view = {
      gameId: s.id,
      phase: s.phase,
      index: s.index,
      total: s.dilemmas.length,
      remainingMs: this._remainingMs(),
      phaseAgeMs: s.phaseStartedAt ? this.now() - s.phaseStartedAt : 0,
      voteSeconds: s.settings.voteSeconds,
      breakdownDelaySeconds: s.settings.breakdownDelaySeconds,
      participants: Object.keys(s.participants).length,
      votedCount: s.index >= 0 && s.votes[s.index] ? Object.keys(s.votes[s.index]).length : 0,
      dilemma: d ? { text: d.text, option1: d.option1, option2: d.option2 } : null,
      results: null,
      summary: null,
    };
    if (s.phase === 'results' && d) view.results = this.results(s.index);
    if (s.phase === 'end') {
      view.summary = s.dilemmas.map((dl, i) => {
        const r = this.results(i);
        return { text: dl.text, option1: dl.option1, option2: dl.option2, counts: r.counts, pct: r.pct, total: r.total, majority: r.majority };
      });
    }
    return view;
  }
}

module.exports = { Game, computeResults, emptyState, VOTE_GRACE_MS, CHOICES };
