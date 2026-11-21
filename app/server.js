'use strict';
// Dilemma voting app — zero dependencies, Node >= 18.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'votes.json');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const CHOICES = new Set(['1', '2']);

if (!ADMIN_PASSWORD) {
  console.warn('WARNING: ADMIN_PASSWORD is not set — the admin screen is disabled.');
}

// ---------- storage: { voters: { [voterId]: "1" | "2" } } ----------
let state = { voters: {} };
try {
  state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!state.voters) state.voters = {};
} catch (e) {
  if (e.code !== 'ENOENT') console.error('Could not read data file, starting empty:', e.message);
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, DATA_FILE);
  }, 200);
}

function tally() {
  const counts = { '1': 0, '2': 0 };
  for (const c of Object.values(state.voters)) if (counts[c] !== undefined) counts[c]++;
  return { one: counts['1'], two: counts['2'], total: counts['1'] + counts['2'] };
}

// ---------- helpers ----------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function voterId(req, res) {
  let id = parseCookies(req).vid;
  if (!id || !/^[a-f0-9]{32}$/.test(id)) {
    id = crypto.randomBytes(16).toString('hex');
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `vid=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`);
  }
  return id;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
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

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dilemma-admin", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Unauthorized');
  return false;
}

function sendFile(res, file) {
  fs.readFile(path.join(PUBLIC_DIR, file), (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/healthz') return sendJson(res, 200, { ok: true });

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      voterId(req, res);
      return sendFile(res, 'index.html');
    }

    if (req.method === 'GET' && p === '/api/me') {
      const id = voterId(req, res);
      return sendJson(res, 200, { choice: state.voters[id] || null });
    }

    if (req.method === 'POST' && p === '/api/vote') {
      const id = voterId(req, res);
      let choice;
      try { choice = String(JSON.parse(await readBody(req)).choice); } catch { return sendJson(res, 400, { error: 'bad request' }); }
      if (!CHOICES.has(choice)) return sendJson(res, 400, { error: 'invalid choice' });
      state.voters[id] = choice;
      scheduleSave();
      return sendJson(res, 200, { choice });
    }

    if (p === '/admin' || p.startsWith('/admin/')) {
      if (!requireAdmin(req, res)) return;
      if (req.method === 'GET' && (p === '/admin' || p === '/admin/')) return sendFile(res, 'admin.html');
      if (req.method === 'GET' && p === '/admin/api/results') return sendJson(res, 200, tally());
      if (req.method === 'POST' && p === '/admin/api/reset') {
        state.voters = {};
        scheduleSave();
        return sendJson(res, 200, tally());
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: 'server error' });
  }
});

server.listen(PORT, HOST, () => console.log(`dilemma listening on http://${HOST}:${PORT}`));

function shutdown() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(state));
  }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
