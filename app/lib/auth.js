'use strict';
// Admin login: credential check, signed session tokens (stateless) and a failed-login limiter.
// Token = "<expiresEpochSec>.<hmac>". The HMAC key mixes a persisted random secret with the admin
// credentials, so changing ADMIN_PASSWORD logs everyone out, while restarts/deploys do not.
const crypto = require('node:crypto');

const REMEMBER_SECONDS = 365 * 24 * 3600;
const SESSION_SECONDS = 12 * 3600; // "remember me" unchecked: browser-session cookie, capped at 12h

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

class Auth {
  constructor({ user, password, secret, now = () => Date.now() }) {
    this.user = user;
    this.password = password;
    this.now = now;
    this.key = crypto.createHmac('sha256', secret).update(`${user}\n${password}`).digest();
  }

  get enabled() { return Boolean(this.password); }

  checkCredentials(user, password) {
    if (!this.enabled) return false;
    const userOk = safeEqual(user, this.user);
    const passOk = safeEqual(password, this.password);
    return userOk && passOk;
  }

  /** "Authorization: Basic ..." header (kept for scripts / curl). */
  checkBasic(header) {
    const m = /^Basic (.+)$/.exec(header || '');
    if (!m) return false;
    const [user, ...rest] = Buffer.from(m[1], 'base64').toString().split(':');
    return this.checkCredentials(user, rest.join(':'));
  }

  /** @returns {{token: string, maxAge: number|null}} maxAge null = browser-session cookie */
  issue(remember) {
    const ttl = remember ? REMEMBER_SECONDS : SESSION_SECONDS;
    const exp = Math.floor(this.now() / 1000) + ttl;
    return { token: `${exp}.${this.sign(exp)}`, maxAge: remember ? ttl : null };
  }

  verify(token) {
    if (!this.enabled || typeof token !== 'string') return false;
    const m = /^(\d{1,12})\.([\w-]{43})$/.exec(token);
    if (!m) return false;
    if (Number(m[1]) * 1000 <= this.now()) return false;
    return safeEqual(m[2], this.sign(m[1]));
  }

  sign(exp) {
    return crypto.createHmac('sha256', this.key).update(`v1.${exp}`).digest('base64url');
  }
}

/** Counts failed logins per key (IP); blocks after `max` failures inside `windowMs`. */
class LoginLimiter {
  constructor({ max = 10, windowMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.fails = new Map();
  }

  blocked(key) {
    const e = this.fails.get(key);
    if (!e) return false;
    if (e.resetAt <= this.now()) { this.fails.delete(key); return false; }
    return e.count >= this.max;
  }

  fail(key) {
    const t = this.now();
    if (this.fails.size > 10000) for (const [k, e] of this.fails) if (e.resetAt <= t) this.fails.delete(k);
    const e = this.fails.get(key);
    if (!e || e.resetAt <= t) this.fails.set(key, { count: 1, resetAt: t + this.windowMs });
    else e.count++;
  }

  success(key) { this.fails.delete(key); }
}

module.exports = { Auth, LoginLimiter, REMEMBER_SECONDS, SESSION_SECONDS };
