'use strict';
// Dilemma game server — zero dependencies, Node >= 18.
//   /             phone voting screen (QR code target)
//   /admin        admin: dilemmas, settings, new game           (HTTP Basic auth)
//   /admin/host   the big screen that runs the game              (HTTP Basic auth)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { Game } = require('./lib/game');
const { JsonStore } = require('./lib/store');
const { SseHub } = require('./lib/sse');
const { DEFAULT_SETTINGS, SEED_DILEMMAS } = require('./lib/defaults');

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
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
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

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const [user, ...rest] = Buffer.from(m[1], 'base64').toString().split(':');
  const userOk = safeEqual(user, ADMIN_USER);
  const passOk = safeEqual(rest.join(':'), ADMIN_PASSWORD);
  return userOk && passOk;
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

  // ----- admin + host (Basic auth) -----
  if (p === '/admin' || p.startsWith('/admin/')) {
    if (!isAdmin(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dilemma-admin", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(ADMIN_PASSWORD ? 'Unauthorized' : 'ADMIN_PASSWORD is not configured on the server');
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
