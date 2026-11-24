'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Auth, LoginLimiter, REMEMBER_SECONDS } = require('../lib/auth');

const mk = (over = {}) => new Auth({ user: 'admin', password: 'pw', secret: 's3cret', ...over });

test('credentials and basic header', () => {
  const a = mk();
  assert.equal(a.checkCredentials('admin', 'pw'), true);
  assert.equal(a.checkCredentials('admin', 'nope'), false);
  assert.equal(a.checkCredentials('root', 'pw'), false);
  assert.equal(a.checkBasic('Basic ' + Buffer.from('admin:pw').toString('base64')), true);
  assert.equal(a.checkBasic('Basic ' + Buffer.from('admin:x').toString('base64')), false);
  assert.equal(a.checkBasic(undefined), false);
  assert.equal(mk({ password: '' }).checkCredentials('admin', ''), false);
});

test('remember-me token verifies until it expires', () => {
  let t = 1_000_000_000_000;
  const a = mk({ now: () => t });
  const { token, maxAge } = a.issue(true);
  assert.equal(maxAge, REMEMBER_SECONDS);
  assert.equal(a.verify(token), true);
  t += (REMEMBER_SECONDS - 60) * 1000;
  assert.equal(a.verify(token), true);
  t += 120 * 1000;
  assert.equal(a.verify(token), false);
});

test('session token has no cookie max-age', () => {
  assert.equal(mk().issue(false).maxAge, null);
});

test('tokens are rejected when tampered, or when the password or secret changes', () => {
  const a = mk();
  const { token } = a.issue(true);
  const [exp, sig] = token.split('.');
  assert.equal(a.verify(`${Number(exp) + 1}.${sig}`), false);
  const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
  assert.equal(a.verify(`${exp}.${flipped}`), false);
  assert.equal(a.verify('garbage'), false);
  assert.equal(mk({ password: 'other' }).verify(token), false);
  assert.equal(mk({ secret: 'other' }).verify(token), false);
  assert.equal(mk().verify(token), true); // same secret + credentials (e.g. after restart)
});

test('login limiter blocks after max failures and resets after the window', () => {
  let t = 0;
  const l = new LoginLimiter({ max: 3, windowMs: 1000, now: () => t });
  l.fail('ip'); l.fail('ip');
  assert.equal(l.blocked('ip'), false);
  l.fail('ip');
  assert.equal(l.blocked('ip'), true);
  assert.equal(l.blocked('other'), false);
  t = 1001;
  assert.equal(l.blocked('ip'), false);
  l.fail('ip'); l.success('ip');
  assert.equal(l.blocked('ip'), false);
});
