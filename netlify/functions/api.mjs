// Netlify Function serving every /api/* route. Queue state lives in Netlify Blobs (store "queue", one key per day).
import { getStore } from '@netlify/blobs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Q = require('../../lib/queue.js');
const N = require('../../lib/notify.js');
const { extractLicense } = require('../../lib/license.js');
const G = require('../../lib/guests.js');

export const config = { path: '/api/*' };

const STAFF_PIN = process.env.STAFF_PIN || '1234';

// ---------- storage ----------
function store() {
  // strong consistency so a write is visible to the very next read (ticket numbering depends on it)
  return getStore({ name: 'queue', consistency: 'strong' });
}

// License photos live in their own store, keyed by ticket id; only the staff endpoint reads them.
function photoStore() {
  return getStore({ name: 'licenses' });
}

async function load() {
  const s = await store().get(Q.today(), { type: 'json' });
  return s && s.date === Q.today() ? s : Q.emptyState();
}

async function save(state) {
  await store().setJSON(state.date, state);
}

// Re-reads the day and changes one ticket, so a slow SMS doesn't overwrite what other staff did meanwhile.
async function updateTicket(id, change) {
  const state = await load();
  const t = state.tickets.find((x) => x.id === id);
  if (!t) return;
  change(t);
  await save(state);
}

// Saves the call first (so the queue moves on even if the SMS fails), then texts the customer once.
async function saveCallAndText(state, t) {
  const claimed = N.claimTurnSms(t);
  await save(state);
  if (!claimed) return t;
  t.sms = await N.sendTurnSms(t);
  await updateTicket(t.id, (x) => (x.sms = t.sms));
  return t;
}

// The dealer guest list isn't per-day, so it survives the daily queue reset.
async function loadGuests() {
  return (await store().get('guest-list', { type: 'json' })) || { guests: [] };
}

// ---------- http helpers ----------
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function readBody(req) {
  try {
    const text = await req.text();
    return text ? JSON.parse(text) : {};
  } catch {
    throw Q.httpError(400, 'Invalid JSON');
  }
}

function requireStaff(req) {
  if (req.headers.get('x-staff-pin') !== STAFF_PIN) throw Q.httpError(401, 'Invalid staff PIN');
}

// ---------- routes ----------
export default async (req) => {
  const { pathname } = new URL(req.url);
  const method = req.method;
  try {
    if (pathname === '/api/state' && method === 'GET') return json(200, Q.publicState(await load()));

    // Lets the form show the invitation as they type; answers with the dealer name only.
    if (pathname === '/api/guest-lookup' && method === 'POST') {
      const guest = G.findGuest(await loadGuests(), await readBody(req));
      return json(200, guest ? { match: true, dealer: guest.dealer } : { match: false });
    }

    // Read a license photo; nothing is saved here, the client fills the form with the result.
    if (pathname === '/api/license-scan' && method === 'POST') return json(200, await extractLicense(await readBody(req)));

    if (pathname === '/api/tickets' && method === 'POST') {
      const body = await readBody(req);
      const photo = Q.decodePhoto(body.licensePhoto);
      const state = await load();
      const t = Q.createTicket(state, { ...G.applyGuest(body, await loadGuests()), hasLicensePhoto: !!photo });
      if (photo) await photoStore().set(t.id, new Blob([photo.bytes], { type: photo.type }), { metadata: { type: photo.type, number: t.number, date: state.date } });
      await save(state);
      return json(201, { ticket: t, position: Q.position(state, t) });
    }

    let m = pathname.match(/^\/api\/tickets\/(\w+)$/);
    if (m && method === 'GET') {
      const state = await load();
      const t = state.tickets.find((x) => x.id === m[1]);
      if (!t) throw Q.httpError(404, 'Ticket not found');
      // The id is unguessable and only the ticket holder has it, so they see their own number in full.
      return json(200, { ticket: t, position: Q.position(state, t) });
    }

    m = pathname.match(/^\/api\/tickets\/(\w+)\/cancel$/);
    if (m && method === 'POST') {
      const state = await load();
      const t = Q.act(state, m[1], 'cancel');
      await save(state);
      return json(200, { ticket: t });
    }

    // ---- staff-only ----
    if (pathname === '/api/staff/login' && method === 'POST') {
      requireStaff(req);
      return json(200, { ok: true });
    }

    if (pathname === '/api/staff/tickets' && method === 'GET') {
      requireStaff(req);
      const state = await load();
      return json(200, { ...Q.publicState(state), tickets: state.tickets });
    }

    if (pathname === '/api/staff/guests') {
      requireStaff(req);
      if (method === 'GET') return json(200, G.summary(await loadGuests()));
      if (method === 'POST') {
        const { list, result } = G.importCsv(await loadGuests(), (await readBody(req)).csv);
        await store().setJSON('guest-list', list);
        return json(200, { ...result, ...G.summary(list) });
      }
      if (method === 'DELETE') {
        await store().delete('guest-list');
        return json(200, G.summary({ guests: [] }));
      }
    }

    m = pathname.match(/^\/api\/staff\/license\/(\w+)$/);
    if (m && method === 'GET') {
      requireStaff(req);
      const r = await photoStore().getWithMetadata(m[1], { type: 'arrayBuffer' });
      if (!r || !r.data) throw Q.httpError(404, 'No license photo for this ticket');
      return new Response(r.data, { status: 200, headers: { 'Content-Type': (r.metadata && r.metadata.type) || 'image/jpeg', 'Cache-Control': 'private, no-store' } });
    }

    m = pathname.match(/^\/api\/staff\/next\/(\w+)$/);
    if (m && method === 'POST') {
      requireStaff(req);
      const state = await load();
      const t = Q.callNext(state, m[1]);
      return json(200, { ticket: await saveCallAndText(state, t) });
    }

    // Re-checks a sent text with the gateway so the staff badge can move on to Delivered / Failed.
    m = pathname.match(/^\/api\/staff\/sms-status\/(\w+)$/);
    if (m && method === 'POST') {
      requireStaff(req);
      const t = (await load()).tickets.find((x) => x.id === m[1]);
      if (!t) throw Q.httpError(404, 'Ticket not found');
      const sms = await N.refreshTurnSms(t.sms);
      if (sms) await updateTicket(t.id, (x) => (x.sms = sms));
      return json(200, { sms: sms || t.sms || null });
    }

    m = pathname.match(/^\/api\/staff\/tickets\/(\w+)\/(\w+)$/);
    if (m && method === 'POST') {
      requireStaff(req);
      const state = await load();
      const t = Q.act(state, m[1], m[2]);
      if (m[2] === 'call') return json(200, { ticket: await saveCallAndText(state, t) });
      await save(state);
      return json(200, { ticket: t });
    }

    // Daily report: which days have data, and everything recorded on one day (including reset batches).
    if (pathname === '/api/staff/report-days' && method === 'GET') {
      requireStaff(req);
      const { blobs } = await store().list();
      const days = [...new Set(blobs.map((b) => (b.key.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1]).filter(Boolean))];
      if (!days.includes(Q.today())) days.push(Q.today());
      return json(200, { days: days.sort().reverse() });
    }

    m = pathname.match(/^\/api\/staff\/report\/(\d{4}-\d{2}-\d{2})$/);
    if (m && method === 'GET') {
      requireStaff(req);
      const { blobs } = await store().list({ prefix: m[1] });
      const states = (await Promise.all(blobs.map((b) => store().get(b.key, { type: 'json' })))).filter(Boolean);
      return json(200, Q.mergeDay(m[1], states));
    }

    if (pathname === '/api/staff/reset' && method === 'POST') {
      requireStaff(req);
      const state = await load();
      // keep the old day's records under an archive key, then start fresh numbering
      await store().setJSON(`${state.date}-archived-${Date.now()}`, state);
      await save(Q.emptyState());
      return json(200, { ok: true });
    }

    throw Q.httpError(404, 'Not found');
  } catch (err) {
    return json(err.status || 500, { error: err.message || 'Server error', ...(err.extra || {}) });
  }
};
