// The one text the app sends: "your turn", when staff call a customer.
// It is best-effort: whatever happens to the SMS, the call itself has already been saved.
const { sendSms, getSmsStatus, normalizePhMobile } = require('./sms');

// The Sales Team's wording. Plain text, no links (PH telcos block SMS with links).
function turnMessage(name, number) {
  const who = String(name || '').trim().replace(/\s+/g, ' ') || 'valued customer';
  return [
    `Good day, ${who}!`,
    `We would like to inform you that your Queue Number ${number} is now being called. Kindly proceed to the XPENG Booth and approach our staff for assistance.`,
    'Please have your queue number ready and make sure to proceed within 10 minutes to avoid delays and cancellation in the process.',
    'Thank you for your patience and cooperation. We look forward to assisting you!',
  ].join('\n');
}

// Call this before saving the call. It marks the ticket so a second click (Recall, double click) doesn't
// text the same person again; returns false when this ticket was already texted or is being texted.
// A failed or skipped text can be retried with Recall.
function claimTurnSms(ticket) {
  const status = ticket.sms && ticket.sms.status;
  if (status === 'sending' || status === 'sent' || status === 'delivered') return false;
  ticket.sms = { status: 'sending', at: Date.now() };
  return true;
}

// Sends the text and returns the record to store on the ticket as `sms`.
async function sendTurnSms(ticket) {
  const at = Date.now();
  if (!normalizePhMobile(ticket.phone)) return { status: 'no_number', at };
  const r = await sendSms(ticket.phone, turnMessage(ticket.name, ticket.number));
  if (r.ok) return { status: 'sent', id: r.id || null, state: r.state || null, sim: r.sim || null, at };
  if (r.error === 'not_configured') return { status: 'off', at };
  return { status: 'failed', error: r.error, at };
}

// Asks the gateway how a sent text is doing. Returns the updated record, or null if nothing changed.
async function refreshTurnSms(sms) {
  if (!sms || sms.status !== 'sent' || !sms.id) return null;
  const r = await getSmsStatus(sms.id);
  if (!r.ok || !r.state || r.state === sms.state) return null;
  const status = r.state === 'Delivered' ? 'delivered' : r.state === 'Failed' ? 'failed' : 'sent';
  return { ...sms, status, state: r.state, ...(status === 'failed' ? { error: 'not_delivered' } : {}), checkedAt: Date.now() };
}

module.exports = { turnMessage, claimTurnSms, sendTurnSms, refreshTurnSms };
