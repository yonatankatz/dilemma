'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Game, VOTE_GRACE_MS } = require('../lib/game');

const SETTINGS = {
  voteSeconds: 20,
  breakdownDelaySeconds: 3,
  segments: [
    { id: 'age', label: 'גיל', options: ['young', 'old'] },
    { id: 'sector', label: 'מגזר', options: ['a', 'b'] },
  ],
};
const DILEMMAS = [
  { id: 'd1', text: 'one?', option1: 'yes', option2: 'no' },
  { id: 'd2', text: 'two?', option1: 'yes', option2: 'no' },
];

function setup() {
  let t = 1_000_000;
  const changes = [];
  const game = new Game({ now: () => t, onChange: (s) => changes.push(s) });
  game.newGame(DILEMMAS, SETTINGS);
  return { game, changes, advance: (ms) => (t += ms) };
}

test('new game starts in lobby with a fresh id', () => {
  const { game } = setup();
  assert.equal(game.state.phase, 'lobby');
  assert.ok(game.state.id);
  assert.equal(game.hostView().total, 2);
});

test('new game requires dilemmas', () => {
  const game = new Game();
  assert.deepEqual(game.newGame([], SETTINGS), { error: 'no_dilemmas' });
  assert.equal(game.state.phase, 'idle');
});

test('full flow: lobby -> vote -> guess -> results -> vote -> ... -> end', () => {
  const { game } = setup();
  const seq = [];
  for (let i = 0; i < 7; i++) {
    game.next();
    seq.push(`${game.state.phase}:${game.state.index}`);
  }
  assert.deepEqual(seq, ['vote:0', 'guess:0', 'results:0', 'vote:1', 'guess:1', 'results:1', 'end:1']);
  assert.deepEqual(game.next(), { error: 'cannot_advance' });
});

test('next() with a stale expectation is ignored (double click protection)', () => {
  const { game } = setup();
  assert.deepEqual(game.next({ phase: 'lobby', index: -1 }), { ok: true });
  assert.deepEqual(game.next({ phase: 'lobby', index: -1 }), { error: 'stale' });
  assert.equal(game.state.phase, 'vote');
});

test('voting rules: must join, once per dilemma, only during vote phase', () => {
  const { game } = setup();
  assert.deepEqual(game.vote('p1', '1', 0), { error: 'not_voting' });
  game.join('p1', { age: 'young' });
  game.next(); // vote 0
  assert.deepEqual(game.vote('p2', '1', 0), { error: 'not_joined' });
  assert.deepEqual(game.vote('p1', '3', 0), { error: 'invalid_choice' });
  assert.deepEqual(game.vote('p1', '1', 1), { error: 'wrong_dilemma' });
  assert.deepEqual(game.vote('p1', '1', 0), { ok: true, choice: '1' });
  assert.deepEqual(game.vote('p1', '2', 0), { error: 'already_voted', choice: '1' });
  assert.equal(game.publicView('p1').voted, '1');
  game.next(); // guess
  assert.deepEqual(game.vote('p1', '2', 0), { error: 'not_voting' });
  game.next(); // results
  game.next(); // vote 1 — can vote again on the next dilemma
  assert.equal(game.publicView('p1').voted, null);
  assert.deepEqual(game.vote('p1', '2', 1), { ok: true, choice: '2' });
});

test('countdown auto-advances to guess after time + grace', () => {
  const { game, advance } = setup();
  game.next();
  assert.equal(game.hostView().remainingMs, 20_000);
  advance(20_000);
  assert.equal(game.tick(), false, 'grace period still open');
  assert.equal(game.hostView().remainingMs, 0);
  advance(VOTE_GRACE_MS);
  assert.equal(game.tick(), true);
  assert.equal(game.state.phase, 'guess');
});

test('join drops profile values that are not configured options', () => {
  const { game } = setup();
  game.join('p1', { age: 'young', sector: 'zzz', other: 'x' });
  assert.deepEqual(game.state.participants.p1.profile, { age: 'young' });
});

test('results: counts, percentages, majority and breakdown', () => {
  const { game } = setup();
  const people = {
    a: { age: 'young', sector: 'a' },
    b: { age: 'young', sector: 'b' },
    c: { age: 'old', sector: 'a' },
    d: { age: 'old' },
  };
  for (const [pid, profile] of Object.entries(people)) game.join(pid, profile);
  game.next();
  game.vote('a', '1');
  game.vote('b', '1');
  game.vote('c', '2');
  game.vote('d', '1');
  game.next();
  game.next();
  const r = game.hostView().results;
  assert.deepEqual(r.counts, { '1': 3, '2': 1 });
  assert.deepEqual(r.pct, { '1': 75, '2': 25 });
  assert.equal(r.majority, '1');
  const age = r.breakdown.find((s) => s.id === 'age');
  assert.deepEqual(age.groups.map((g) => [g.value, g.counts['1'], g.counts['2']]), [['young', 2, 0], ['old', 1, 1]]);
  const sector = r.breakdown.find((s) => s.id === 'sector');
  assert.deepEqual(sector.groups.map((g) => [g.value, g.total]), [['a', 2], ['b', 1]]);
});

test('results: tie and no votes', () => {
  const { game } = setup();
  game.join('a', {});
  game.join('b', {});
  game.next();
  assert.equal(game.results(0).majority, null);
  game.vote('a', '1');
  game.vote('b', '2');
  assert.equal(game.results(0).majority, 'tie');
  assert.deepEqual(game.results(0).breakdown, []);
});

test('public view never leaks dilemma text or other votes', () => {
  const { game } = setup();
  game.join('a', {});
  game.join('b', {});
  game.next();
  game.vote('a', '1');
  const v = game.publicView('b');
  assert.equal(v.voted, null);
  assert.equal(JSON.stringify(v).includes('one?'), false);
});

test('end summary lists every dilemma', () => {
  const { game } = setup();
  game.end();
  const v = game.hostView();
  assert.equal(v.phase, 'end');
  assert.equal(v.summary.length, 2);
});
