// XPeng Test Drive Queue — local/showroom Node server (zero dependencies).
// Run: node server.js   (PORT and STAFF_PIN can be set via env)
// The same routes are served on Netlify by netlify/functions/api.mjs; queue rules live in lib/queue.js.
const http = require('http');
const fs = require('fs');
const path = require('path');

// Load .env (KEY=value lines) for local runs; real environment variables win. Keep .env out of git.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}

const Q = require('./lib/queue');
const N = require('./lib/notify');
const { extractLicense } = require('./lib/license');
const G = require('./lib/guests');

const PORT = Number(process.env.PORT) || 3000;
const STAFF_PIN = process.env.STAFF_PIN || '1234';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'queue.json');
const LICENSE_DIR = path.join(DATA_DIR, 'licenses'); // license photos, one file per ticket id
const GUESTS_FILE = path.join(DATA_DIR, 'guests.json'); // dealer guest list, kept across days
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- persistence ----------
function load() {
  try {
    const s = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return s.date === Q.today() ? s : archive(s);
  } catch {
    return Q.emptyState();
  }
}

// New day: keep yesterday's file for records, start fresh numbering.
function archive(old) {
  try {
    // a mid-day reset already wrote this day's file once; don't overwrite it at day end
    const first = path.join(DATA_DIR, `queue-${old.date}.json`);
    const file = fs.existsSync(first) ? path.join(DATA_DIR, `queue-${old.date}-${Date.now()}.json`) : first;
    fs.writeFileSync(file, JSON.stringify(old, null, 2));
  } catch {}
  return Q.emptyState();
}

let state = load();

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

function loadGuests() {
  try {
    return JSON.parse(fs.readFileSync(GUESTS_FILE, 'utf8'));
  } catch {
    return { guests: [] };
  }
}

function saveGuests(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(GUESTS_FILE, JSON.stringify(list, null, 2));
}

// Saves the call first (so the queue moves on even if the SMS fails), then texts the customer once.
async function saveCallAndText(t) {
  const claimed = N.claimTurnSms(t);
  save();
  if (!claimed) return t;
  t.sms = await N.sendTurnSms(t);
  save();
  return t;
}

function rollover() {
  if (state.date !== Q.today()) {
    state = archive(state);
    save();
  }
}

// ---------- http helpers ----------
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 6e6) req.destroy(); // license photos are ~0.3 MB after client-side downsizing
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(Q.httpError(400, 'Invalid JSON'));
      }
    });
  });
}

function requireStaff(req) {
  if (req.headers['x-staff-pin'] !== STAFF_PIN) throw Q.httpError(401, 'Invalid staff PIN');
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (!path.extname(pathname)) pathname += '.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'Not found' });
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': (MIME[ext] || 'application/octet-stream') + '; charset=utf-8',
      // pages and scripts must always be revalidated so edits show up on the next load; images can be cached
      'Cache-Control': ext === '.png' ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(buf);
  });
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    rollover();

    if (pathname === '/api/state' && req.method === 'GET') return send(res, 200, Q.publicState(state));

    if (pathname === '/api/guest-lookup' && req.method === 'POST') {
      const guest = G.findGuest(loadGuests(), await readBody(req));
      return send(res, 200, guest ? { match: true, dealer: guest.dealer } : { match: false });
    }

    if (pathname === '/api/license-scan' && req.method === 'POST') return send(res, 200, await extractLicense(await readBody(req)));

    if (pathname === '/api/tickets' && req.method === 'POST') {
      const body = await readBody(req);
      const photo = Q.decodePhoto(body.licensePhoto);
      const t = Q.createTicket(state, { ...G.applyGuest(body, loadGuests()), hasLicensePhoto: !!photo });
      if (photo) {
        fs.mkdirSync(LICENSE_DIR, { recursive: true });
        fs.writeFileSync(path.join(LICENSE_DIR, `${t.id}.${photo.type.split('/')[1]}`), photo.bytes);
      }
      save();
      return send(res, 201, { ticket: t, position: Q.position(state, t) });
    }

    let m = pathname.match(/^\/api\/tickets\/(\w+)$/);
    if (m && req.method === 'GET') {
      const t = state.tickets.find((x) => x.id === m[1]);
      if (!t) throw Q.httpError(404, 'Ticket not found');
      // The id is unguessable and only the ticket holder has it, so they see their own number in full.
      return send(res, 200, { ticket: t, position: Q.position(state, t) });
    }

    // Customer may cancel their own ticket (they hold the unguessable id)
    m = pathname.match(/^\/api\/tickets\/(\w+)\/cancel$/);
    if (m && req.method === 'POST') {
      const t = Q.act(state, m[1], 'cancel');
      save();
      return send(res, 200, { ticket: t });
    }

    // ---- staff-only ----
    if (pathname === '/api/staff/login' && req.method === 'POST') {
      requireStaff(req);
      return send(res, 200, { ok: true });
    }

    if (pathname === '/api/staff/tickets' && req.method === 'GET') {
      requireStaff(req);
      return send(res, 200, { ...Q.publicState(state), tickets: state.tickets });
    }

    if (pathname === '/api/staff/guests') {
      requireStaff(req);
      if (req.method === 'GET') return send(res, 200, G.summary(loadGuests()));
      if (req.method === 'POST') {
        const { list, result } = G.importCsv(loadGuests(), (await readBody(req)).csv);
        saveGuests(list);
        return send(res, 200, { ...result, ...G.summary(list) });
      }
      if (req.method === 'DELETE') {
        saveGuests({ guests: [] });
        return send(res, 200, G.summary({ guests: [] }));
      }
    }

    m = pathname.match(/^\/api\/staff\/license\/(\w+)$/);
    if (m && req.method === 'GET') {
      requireStaff(req);
      const file = ['jpeg', 'png', 'webp'].map((e) => path.join(LICENSE_DIR, `${m[1]}.${e}`)).find((f) => fs.existsSync(f));
      if (!file) throw Q.httpError(404, 'No license photo for this ticket');
      res.writeHead(200, { 'Content-Type': `image/${path.extname(file).slice(1)}`, 'Cache-Control': 'private, no-store' });
      return res.end(fs.readFileSync(file));
    }

    m = pathname.match(/^\/api\/staff\/next\/(\w+)$/);
    if (m && req.method === 'POST') {
      requireStaff(req);
      const t = Q.callNext(state, m[1]);
      return send(res, 200, { ticket: await saveCallAndText(t) });
    }

    // Re-checks a sent text with the gateway so the staff badge can move on to Delivered / Failed.
    m = pathname.match(/^\/api\/staff\/sms-status\/(\w+)$/);
    if (m && req.method === 'POST') {
      requireStaff(req);
      const t = state.tickets.find((x) => x.id === m[1]);
      if (!t) throw Q.httpError(404, 'Ticket not found');
      const sms = await N.refreshTurnSms(t.sms);
      if (sms) {
        t.sms = sms;
        save();
      }
      return send(res, 200, { sms: t.sms || null });
    }

    m = pathname.match(/^\/api\/staff\/tickets\/(\w+)\/(\w+)$/);
    if (m && req.method === 'POST') {
      requireStaff(req);
      const t = Q.act(state, m[1], m[2]);
      if (m[2] === 'call') return send(res, 200, { ticket: await saveCallAndText(t) });
      save();
      return send(res, 200, { ticket: t });
    }

    // Daily report: today's live queue plus any archived files for the day (from day end or a mid-day reset).
    if (pathname === '/api/staff/report-days' && req.method === 'GET') {
      requireStaff(req);
      const files = fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR) : [];
      const days = [...new Set([state.date, ...files.map((f) => (f.match(/^queue-(\d{4}-\d{2}-\d{2})/) || [])[1]).filter(Boolean)])];
      return send(res, 200, { days: days.sort().reverse() });
    }

    m = pathname.match(/^\/api\/staff\/report\/(\d{4}-\d{2}-\d{2})$/);
    if (m && req.method === 'GET') {
      requireStaff(req);
      const files = fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR).filter((f) => f.startsWith(`queue-${m[1]}`)) : [];
      const states = files.map((f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')));
      if (state.date === m[1]) states.push(state);
      return send(res, 200, Q.mergeDay(m[1], states));
    }

    if (pathname === '/api/staff/reset' && req.method === 'POST') {
      requireStaff(req);
      state = archive(state);
      save();
      return send(res, 200, { ok: true });
    }

    if (pathname.startsWith('/api/')) throw Q.httpError(404, 'Not found');
    return serveStatic(req, res, pathname);
  } catch (err) {
    send(res, err.status || 500, { error: err.message || 'Server error', ...(err.extra || {}) });
  }
});

server.listen(PORT, () => {
  console.log(`XPeng Test Drive Queue running:`);
  console.log(`  Customer kiosk : http://localhost:${PORT}/`);
  console.log(`  Staff console  : http://localhost:${PORT}/staff   (PIN: ${STAFF_PIN === '1234' ? '1234 — set STAFF_PIN to change' : 'set via STAFF_PIN'})`);
  console.log(`  Lobby display  : http://localhost:${PORT}/display`);
});
