// SMS sending — server side only (credentials come from env and never reach the browser).
// Provider is picked from env:
//   SMS_GATEWAY_USER → SMS Gateway for Android cloud (https://api.sms-gate.app), with SMS_GATEWAY_URL,
//                      SMS_GATEWAY_PASS and SMS_SIMS (SIM slot(s) to send from, e.g. "2" or "1,2")
//   TRACCAR_KEY      → Traccar SMS Gateway app in Cloud mode (https://www.traccar.org/sms/)
//   SEMAPHORE_KEY    → Semaphore (PH), optional SEMAPHORE_SENDER (default "SEMAPHORE")
//   none of these    → messages are logged and skipped (app keeps working without SMS)
// Set SMS_PROVIDER=none to force-disable even if a key is present.

// Netlify stops a function after 10 s, so the gateway must answer well before that.
const TIMEOUT_MS = 7000;

function provider() {
  if (process.env.SMS_PROVIDER === 'none') return 'none';
  if (process.env.SMS_PROVIDER) return process.env.SMS_PROVIDER;
  if (process.env.SMS_GATEWAY_USER) return 'smsgate';
  if (process.env.TRACCAR_KEY) return 'traccar';
  if (process.env.SEMAPHORE_KEY) return 'semaphore';
  return 'none';
}

// 09171234567 / 9171234567 / 639171234567 / +639171234567 -> +639171234567; anything else -> null
function normalizePhMobile(input) {
  const digits = String(input || '').replace(/\D/g, '');
  let local;
  if (digits.length === 11 && digits.startsWith('09')) local = digits.slice(1);
  else if (digits.length === 12 && digits.startsWith('639')) local = digits.slice(2);
  else if (digits.length === 10 && digits.startsWith('9')) local = digits;
  else return null;
  return '+63' + local;
}

async function request(url, { method = 'POST', headers, body }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, body: text.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

function gatewayAuth() {
  return 'Basic ' + Buffer.from(`${process.env.SMS_GATEWAY_USER}:${process.env.SMS_GATEWAY_PASS}`).toString('base64');
}

function gatewayBase() {
  return (process.env.SMS_GATEWAY_URL || 'https://api.sms-gate.app/3rdparty/v1').replace(/\/$/, '');
}

// Rotates through SMS_SIMS so "1,2" spreads messages over both SIMs.
let simTurn = 0;
function nextSim() {
  const sims = String(process.env.SMS_SIMS || '2').split(',').map((s) => Number(s.trim())).filter(Boolean);
  return sims[simTurn++ % sims.length] || undefined;
}

// Returns { ok, id?, state?, sim?, error? }. Never throws.
async function sendSms(phone, text) {
  const to = normalizePhMobile(phone);
  if (!to) return { ok: false, error: 'invalid_number' };
  const which = provider();
  try {
    if (which === 'smsgate') {
      const sim = nextSim();
      const r = await request(`${gatewayBase()}/messages`, {
        headers: { Authorization: gatewayAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ textMessage: { text }, phoneNumbers: [to], simNumber: sim }),
      });
      if (!r.ok) {
        console.log(`[sms:smsgate] ${to} → FAILED ${r.status} ${r.body}`);
        return { ok: false, error: `gateway_${r.status}` };
      }
      const data = JSON.parse(r.body || '{}');
      console.log(`[sms:smsgate] ${to} → accepted ${data.id} (${data.state}, SIM ${sim})`);
      return { ok: true, id: data.id, state: data.state, sim };
    }
    if (which === 'traccar') {
      const r = await request('https://www.traccar.org/sms/', {
        headers: { 'Content-Type': 'application/json', Authorization: process.env.TRACCAR_KEY },
        body: JSON.stringify({ to, message: text }),
      });
      // Traccar replies 200 even on failure; the verdict is in the body ({"successCount":1,"failureCount":0,...})
      let ok = r.ok;
      try {
        const j = JSON.parse(r.body);
        if (typeof j.failureCount === 'number') ok = j.failureCount === 0 && j.successCount > 0;
      } catch {}
      console.log(`[sms:traccar] ${to} → ${ok ? 'sent' : 'FAILED ' + r.status + ' ' + r.body}`);
      return ok ? { ok: true } : { ok: false, error: `traccar_${r.status}` };
    }
    if (which === 'semaphore') {
      const r = await request('https://api.semaphore.co/api/v4/messages', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apikey: process.env.SEMAPHORE_KEY, number: to, message: text, sendername: process.env.SEMAPHORE_SENDER || 'SEMAPHORE' }),
      });
      console.log(`[sms:semaphore] ${to} → ${r.ok ? 'sent' : 'FAILED ' + r.status + ' ' + r.body}`);
      return r.ok ? { ok: true } : { ok: false, error: `semaphore_${r.status}` };
    }
    console.log(`[sms:skipped] ${to}: ${text}`);
    return { ok: false, error: 'not_configured' };
  } catch (err) {
    const error = err.name === 'AbortError' ? 'timeout' : 'network';
    console.log(`[sms:${which}] ${to} → ERROR ${error} ${err.message}`);
    return { ok: false, error };
  }
}

// Delivery check for a message sent through the gateway: Pending | Processed | Sent | Delivered | Failed
async function getSmsStatus(id) {
  if (provider() !== 'smsgate' || !id) return { ok: false, error: 'not_supported' };
  try {
    const r = await request(`${gatewayBase()}/messages/${encodeURIComponent(id)}`, { method: 'GET', headers: { Authorization: gatewayAuth() } });
    if (!r.ok) return { ok: false, error: `gateway_${r.status}` };
    return { ok: true, state: JSON.parse(r.body || '{}').state };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : 'network' };
  }
}

module.exports = { sendSms, getSmsStatus, normalizePhMobile, provider };
