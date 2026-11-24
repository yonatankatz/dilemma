'use strict';
// Dilemma game server — zero dependencies, Node >= 18.
//   /             phone voting screen (QR code target)
//   /admin        admin: dilemmas, settings, new game           (login required)
//   /admin/host   the big screen that runs the game              (login required)
//   /login        login page (signed "remember me" cookie; Basic auth also accepted for scripts)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { Game } = require('./lib/game');
const { JsonStore } = require('./lib/store');
const { SseHub } = require('./lib/sse');
const { DEFAULT_SETTINGS, SEED_DILEMMAS } = require('./lib/defaults');
const { Auth, LoginLimiter } = require('./lib/auth');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD is not set — admin and host screens are disabled.');

// ---------- persistent data ----------
const store = new JsonStore(DATA_DIR);

const newDilemmaId = () => crypto.randomBytes(5).toString('hex');

let dilemmas = store.read('dilemmas.json', null);
if (!Array.isArray(dilemmas)) {
  dilemmas = SEED_DILEMMAS.map((d) => ({ id: newDilemmaId(), active: true, ...d }));
  store.write('dilemmas.json', dilemmas);
}

let settings = { ...DEFAULT_SETTINGS, ...store.read('settings.json', {}) };

// Random signing secret, persisted so logins survive restarts and deploys.
let authSecret = store.read('auth-secret.json', null)?.secret;
if (!authSecret) {
  authSecret = crypto.randomBytes(32).toString('hex');
  store.write('auth-secret.json', { secret: authSecret });
}
const auth = new Auth({ user: ADMIN_USER, password: ADMIN_PASSWORD, secret: authSecret });
const loginLimiter = new LoginLimiter();
const SESSION_COOKIE = 'adm';

const hub = new SseHub({
  public: (pid) => game.publicView(pid),
  host: () => game.hostView(),
});

const game = new Game({
  initial: store.read('game.json', null),
  onChange: (scope) => {
    store.writeSoon('game.json', () => game.state);
    hub.notify(scope);
  },
});
setInterval(() => game.tick(), 200);

function archiveCurrentGame() {
  const s = game.state;
  if (s.id && s.phase !== 'idle') store.write(`games/${s.id}.json`, s);
}

// ---------- validation ----------
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function validateDilemmas(list) {
  if (!Array.isArray(list)) throw new HttpError(400, 'expected an array');
  if (list.length > 500) throw new HttpError(400, 'too many dilemmas');
  return list.map((d, i) => {
    const out = {
      id: typeof d.id === 'string' && /^[a-z0-9]{4,20}$/.test(d.id) ? d.id : newDilemmaId(),
      text: str(d.text, 600),
      option1: str(d.option1, 120),
      option2: str(d.option2, 120),
      active: d.active !== false,
    };
    if (!out.text || !out.option1 || !out.option2) throw new HttpError(400, `dilemma #${i + 1} is missing text`);
    return out;
  });
}

function validateSettings(input) {
  const num = (v, min, max, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
  };
  const segments = Array.isArray(input.segments) ? input.segments : settings.segments;
  if (segments.length > 5) throw new HttpError(400, 'up to 5 segments');
  return {
    voteSeconds: num(input.voteSeconds, 3, 300, settings.voteSeconds),
    breakdownDelaySeconds: num(input.breakdownDelaySeconds, 0, 30, settings.breakdownDelaySeconds),
    segments: segments.map((seg, i) => {
      const label = str(seg.label, 40);
      const options = [...new Set((Array.isArray(seg.options) ? seg.options : []).map((o) => str(o, 40)).filter(Boolean))].slice(0, 10);
      if (!label) throw new HttpError(400, `segment #${i + 1} needs a title`);
      if (options.length < 2) throw new HttpError(400, `segment "${label}" needs at least 2 options`);
      const id = typeof seg.id === 'string' && /^[a-z0-9_-]{1,20}$/i.test(seg.id) ? seg.id : `seg${crypto.randomBytes(3).toString('hex')}`;
      return { id, label, options };
    }),
  };
}

// ---------- http helpers ----------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Anonymous participant id, kept in a long-lived cookie. */
function participantId(req, res) {
  let id = parseCookies(req).pid;
  if (!id || !/^[a-f0-9]{32}$/.test(id)) {
    id = crypto.randomBytes(16).toString('hex');
    const secure = isHttps(req) ? '; Secure' : '';
    res.setHeader('Set-Cookie', `pid=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`);
  }
  return id;
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Reads a JSON body. Requiring the JSON content type also blocks cross-site form posts (CSRF). */
function readJson(req, limit = 16 * 1024) {
  if (!/^application\/json/i.test(req.headers['content-type'] || '')) {
    return Promise.reject(new HttpError(415, 'expected application/json'));
  }
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new HttpError(400, 'invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function isAdmin(req) {
  return auth.verify(parseCookies(req)[SESSION_COOKIE]) || auth.checkBasic(req.headers.authorization);
}

const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https';

function setSessionCookie(req, res, value, maxAge) {
  const parts = [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAge != null) parts.push(`Max-Age=${maxAge}`);
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/** Client IP. Caddy (the only thing in front of us) sets X-Forwarded-For; the last entry is the one it saw. */
function clientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return xff[xff.length - 1] || req.socket.remoteAddress || '';
}

/** Only /admin paths are allowed as post-login destinations (no open redirect). */
const safeNext = (v) => (typeof v === 'string' && /^\/admin(\/[\w./-]*)?$/.test(v) && !v.includes('..') ? v : '/admin');

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(res, relPath) {
  const file = path.normalize(path.join(PUBLIC_DIR, relPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return notFound(res);
  const type = MIME[path.extname(file)];
  if (!type) return notFound(res);
  fs.readFile(file, (err, buf) => {
    if (err) return notFound(res);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function resultsCsv() {
  const s = game.state;
  const rows = [['#', 'דילמה', 'אפשרות 1', 'אפשרות 2', 'פילוח', 'קבוצה', 'הצביעו 1', 'הצביעו 2', 'סה"כ', '% 1', '% 2']];
  s.dilemmas.forEach((d, i) => {
    const r = game.results(i);
    rows.push([i + 1, d.text, d.option1, d.option2, 'כולם', '', r.counts['1'], r.counts['2'], r.total, r.pct['1'], r.pct['2']]);
    for (const seg of r.breakdown) {
      for (const g of seg.groups) {
        rows.push([i + 1, d.text, d.option1, d.option2, seg.label, g.value, g.counts['1'], g.counts['2'], g.total, g.pct['1'], g.pct['2']]);
      }
    }
  });
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;

  if (m === 'GET' && p === '/healthz') return sendJson(res, 200, { ok: true, clients: hub.counts() });

  // ----- phones -----
  if (m === 'GET' && (p === '/' || p === '/index.html')) {
    participantId(req, res);
    return serveStatic(res, 'play.html');
  }
  if (m === 'GET' && p === '/api/events') return hub.connect(req, res, 'public', participantId(req, res));
  if (m === 'GET' && p === '/api/state') return sendJson(res, 200, game.publicView(participantId(req, res)));
  if (m === 'POST' && p === '/api/join') {
    const pid = participantId(req, res);
    const body = await readJson(req);
    const r = game.join(pid, body.profile || {});
    return sendJson(res, r.error ? 409 : 200, { ...r, state: game.publicView(pid) });
  }
  if (m === 'POST' && p === '/api/vote') {
    const pid = participantId(req, res);
    const body = await readJson(req);
    const r = game.vote(pid, body.choice, body.index);
    return sendJson(res, r.error ? 409 : 200, r);
  }
  if (m === 'GET' && /^\/(css|js|vendor)\/[\w./-]+$/.test(p)) return serveStatic(res, p.slice(1));

  // ----- login -----
  if (m === 'GET' && p === '/login') {
    if (isAdmin(req)) return redirect(res, safeNext(url.searchParams.get('next')));
    return serveStatic(res, 'login.html');
  }
  if (m === 'POST' && p === '/api/login') {
    const body = await readJson(req);
    if (!auth.enabled) return sendJson(res, 503, { error: 'not_configured' });
    const ip = clientIp(req);
    if (loginLimiter.blocked(ip)) return sendJson(res, 429, { error: 'too_many_attempts' });
    const password = typeof body.password === 'string' ? body.password : '';
    if (!auth.checkCredentials(str(body.user, 100), password)) {
      loginLimiter.fail(ip);
      await new Promise((r) => setTimeout(r, 400));
      return sendJson(res, 401, { error: 'bad_credentials' });
    }
    loginLimiter.success(ip);
    const { token, maxAge } = auth.issue(body.remember !== false);
    setSessionCookie(req, res, token, maxAge);
    return sendJson(res, 200, { ok: true, next: safeNext(body.next) });
  }
  if (m === 'POST' && p === '/api/logout') {
    await readJson(req);
    setSessionCookie(req, res, '', 0);
    return sendJson(res, 200, { ok: true });
  }

  // ----- admin + host (login required) -----
  if (p === '/admin' || p.startsWith('/admin/')) {
    if (!isAdmin(req)) {
      if (m === 'GET' && !p.startsWith('/admin/api/')) return redirect(res, `/login?next=${encodeURIComponent(p)}`);
      return sendJson(res, 401, { error: ADMIN_PASSWORD ? 'unauthorized' : 'not_configured' });
    }
    if (m === 'GET' && (p === '/admin' || p === '/admin/')) return serveStatic(res, 'admin.html');
    if (m === 'GET' && p === '/admin/host') return serveStatic(res, 'host.html');
    if (m === 'GET' && p === '/admin/api/events') return hub.connect(req, res, 'host');
    if (m === 'GET' && p === '/admin/api/game') return sendJson(res, 200, game.hostView());

    if (m === 'GET' && p === '/admin/api/dilemmas') return sendJson(res, 200, dilemmas);
    if (m === 'PUT' && p === '/admin/api/dilemmas') {
      dilemmas = validateDilemmas(await readJson(req, 512 * 1024));
      store.write('dilemmas.json', dilemmas);
      return sendJson(res, 200, dilemmas);
    }
    if (m === 'GET' && p === '/admin/api/settings') return sendJson(res, 200, settings);
    if (m === 'PUT' && p === '/admin/api/settings') {
      settings = validateSettings(await readJson(req));
      store.write('settings.json', settings);
      return sendJson(res, 200, settings);
    }
    if (m === 'POST' && p === '/admin/api/game/new') {
      await readJson(req);
      const active = dilemmas.filter((d) => d.active);
      if (!active.length) return sendJson(res, 409, { error: 'no_dilemmas' });
      archiveCurrentGame();
      const r = game.newGame(active, settings);
      return sendJson(res, r.error ? 409 : 200, { ...r, game: game.hostView() });
    }
    if (m === 'POST' && p === '/admin/api/game/next') {
      const body = await readJson(req);
      const r = game.next(body.expected);
      return sendJson(res, r.error ? 409 : 200, { ...r, game: game.hostView() });
    }
    if (m === 'POST' && p === '/admin/api/game/end') {
      await readJson(req);
      const r = game.end();
      archiveCurrentGame();
      return sendJson(res, 200, { ...r, game: game.hostView() });
    }
    if (m === 'GET' && p === '/admin/api/game/results.csv') {
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="dilemma-results-${game.state.id || 'none'}.csv"`,
        'Cache-Control': 'no-store',
      });
      return res.end(resultsCsv());
    }
  }

  return notFound(res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) sendJson(res, status, { error: e.message || 'server error' });
  });
});
server.keepAliveTimeout = 65000;

server.listen(PORT, HOST, () => console.log(`dilemma listening on http://${HOST}:${PORT} (data: ${DATA_DIR})`));

function shutdown() {
  try {
    store.flush();
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
