const crypto = require('crypto');

// Queue rules shared by the local Node server (server.js) and the Netlify function (netlify/functions/api.mjs).
// Everything here is plain state-in / state-out; persistence lives in the caller.

// Models offered for test drive. `units` = demo cars available, `minutes` = avg drive length.
const MODELS = [
  { id: 'L03', name: 'L03', prefix: 'L', tagline: 'Smart Coupe SUV', image: '/img/l03.png', units: 1, minutes: 20 },
  { id: 'X9', name: 'X9', prefix: 'X', tagline: 'Flagship Smart MPV', image: '/img/x9.png', units: 1, minutes: 25 },
];

const ACTIVE = ['waiting', 'called', 'driving'];

// Showroom's local day, regardless of where the code runs (Netlify functions run in UTC).
const TZ = process.env.QUEUE_TZ || 'Asia/Manila';
function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}

function emptyState() {
  return { date: today(), counters: {}, tickets: [] };
}

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, extra });
}

function maskPhone(p = '') {
  return p.length > 4 ? p.slice(0, 2) + '•'.repeat(p.length - 4) + p.slice(-2) : p;
}

function publicState(state) {
  return {
    date: state.date,
    models: MODELS.map((m) => {
      const waiting = state.tickets.filter((t) => t.model === m.id && t.status === 'waiting');
      return { ...m, waitingCount: waiting.length, estWaitMin: Math.ceil(waiting.length / m.units) * m.minutes };
    }),
    // Anyone can read this, so it lists only what the lobby display needs. Never add the ticket id:
    // it is what lets a customer open and cancel their own ticket.
    tickets: state.tickets.map((t) => ({
      number: t.number,
      model: t.model,
      name: t.name.split(' ')[0],
      status: t.status,
      createdAt: t.createdAt,
      calledAt: t.calledAt,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
    })),
    customerTypes: CUSTOMER_TYPES,
  };
}

function position(state, ticket) {
  if (ticket.status !== 'waiting') return 0;
  return state.tickets.filter((t) => t.model === ticket.model && t.status === 'waiting' && t.createdAt <= ticket.createdAt).length;
}

// Splits a "data:image/jpeg;base64,..." string into bytes + type, or returns null. Used by both servers
// to store the license photo; the photo itself never goes into the queue state.
function decodePhoto(dataUrl) {
  const m = String(dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > 4 * 1024 * 1024) throw httpError(413, 'Photo is too large');
  return { type: m[1], bytes };
}

// How the customer came to the event (asked for by the Sales Team).
const CUSTOMER_TYPES = {
  walk_in: 'Walk-in',
  xpeng_ph: 'Signed up thru XPENG Philippines',
  dealer: 'Invited by dealer / signed up thru dealer',
};

function createTicket(state, { model, name, phone, email, municipality, customerType, dealer, guestMatched, licenseNumber, licenseExpiry, hasLicensePhoto }) {
  const m = MODELS.find((x) => x.id === model);
  if (!m) throw httpError(400, 'Unknown model');
  name = String(name || '').trim().slice(0, 60);
  phone = String(phone || '').replace(/[^\d+]/g, '').slice(0, 16);
  email = String(email || '').trim().toLowerCase().slice(0, 120);
  municipality = String(municipality || '').trim().slice(0, 80);
  dealer = customerType === 'dealer' ? String(dealer || '').trim().slice(0, 80) : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'A valid e-mail address is required');
  if (!municipality) throw httpError(400, 'Municipality of residence is required');
  if (!CUSTOMER_TYPES[customerType]) throw httpError(400, 'Customer type is required');
  if (customerType === 'dealer' && !dealer) throw httpError(400, 'Please tell us which dealer invited you');
  if (!name) throw httpError(400, 'Name is required');
  if (phone.replace(/\D/g, '').length < 7) throw httpError(400, 'A valid mobile number is required');
  // License details come from the scan (or typed in); kept as text only, the photo is never stored.
  licenseNumber = String(licenseNumber || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20) || null;
  licenseExpiry = /^\d{4}-\d{2}-\d{2}$/.test(licenseExpiry || '') ? licenseExpiry : null;
  if (!licenseNumber) throw httpError(400, 'Driver\'s license number is required');
  if (!licenseExpiry) throw httpError(400, 'License expiration date is required');
  if (licenseExpiry < today()) throw httpError(400, `This license expired on ${licenseExpiry.replace(/-/g, '/')}. A valid license is required to test drive.`);

  const dupe = state.tickets.find((t) => t.phone === phone && t.model === model && ACTIVE.includes(t.status));
  // The person typing may not be the ticket holder, so the reply carries no ticket details.
  if (dupe) throw httpError(409, `You are already in the ${m.name} queue as ${dupe.number}`);

  state.counters[model] = (state.counters[model] || 0) + 1;
  const ticket = {
    id: crypto.randomBytes(16).toString('hex'),
    number: `${m.prefix}${String(state.counters[model]).padStart(3, '0')}`,
    model,
    name,
    phone,
    email,
    municipality,
    customerType,
    dealer: dealer || null,
    guestMatched: !!guestMatched,
    licenseNumber,
    licenseExpiry,
    hasLicensePhoto: !!hasLicensePhoto,
    status: 'waiting',
    createdAt: Date.now(),
  };
  state.tickets.push(ticket);
  return ticket;
}

const TRANSITIONS = {
  call: { from: ['waiting', 'called'], to: 'called', stamp: 'calledAt' },
  start: { from: ['called'], to: 'driving', stamp: 'startedAt' },
  finish: { from: ['driving'], to: 'done', stamp: 'finishedAt' },
  noshow: { from: ['called'], to: 'noshow', stamp: 'finishedAt' },
  requeue: { from: ['called', 'noshow'], to: 'waiting', stamp: null },
  cancel: { from: ['waiting', 'called'], to: 'cancelled', stamp: 'finishedAt' },
};

function act(state, id, action) {
  const t = state.tickets.find((x) => x.id === id);
  if (!t) throw httpError(404, 'Ticket not found');
  const tr = TRANSITIONS[action];
  if (!tr) throw httpError(400, 'Unknown action');
  if (!tr.from.includes(t.status)) throw httpError(409, `Cannot ${action} a ticket that is ${t.status}`);
  t.status = tr.to;
  if (tr.stamp) t[tr.stamp] = Date.now();
  if (action === 'requeue') {
    t.createdAt = Date.now(); // back of the line
    delete t.sms; // a new call later gets a new text
  }
  return t;
}

function callNext(state, model) {
  const next = state.tickets
    .filter((t) => t.model === model && t.status === 'waiting')
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!next) throw httpError(404, 'No one waiting for this model');
  return act(state, next.id, 'call');
}

// A day can be stored in several pieces when staff reset the queue mid-day; the report wants all of them.
function mergeDay(date, states) {
  const tickets = states.flatMap((s) => s.tickets || []).sort((a, b) => a.createdAt - b.createdAt);
  return { date, today: today(), models: MODELS, customerTypes: CUSTOMER_TYPES, tickets };
}

module.exports = { mergeDay, MODELS, ACTIVE, CUSTOMER_TYPES, today, emptyState, httpError, maskPhone, publicState, position, createTicket, act, callNext, decodePhoto };
