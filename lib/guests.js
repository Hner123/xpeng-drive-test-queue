// Dealer guest list: staff upload who each dealer invited, and a customer registering with a
// matching mobile number or e-mail is tagged with that dealer automatically.
// Names are deliberately not matched: spellings vary and two people can share one.
const { httpError } = require('./queue');

const COLUMNS = {
  name: ['name', 'full name', 'complete name', 'customer name', 'guest name'],
  phone: ['mobile', 'mobile number', 'mobile no', 'mobile no.', 'phone', 'phone number', 'contact', 'contact number', 'contact no', 'contact no.', 'cellphone', 'cellphone number', 'cp number', 'number'],
  email: ['email', 'e-mail', 'email address', 'e-mail address'],
  dealer: ['dealer', 'inviting dealer', 'dealer name', 'invited by', 'dealership'],
};

// 09171234567, +639171234567, 639171234567 and 9171234567 are all the same number.
// (Excel drops the leading zero, so the last ten digits are what we compare.)
function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function parseCsv(text) {
  text = String(text || '').replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  // Some Excel regional settings save CSV with semicolons
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell);
  rows.push(row);
  return rows.filter((r) => r.some((v) => v.trim()));
}

function columnIndex(header, names) {
  return header.findIndex((h) => names.includes(h.trim().toLowerCase()));
}

// Adds the uploaded rows to the list. A row whose mobile number or e-mail is already listed replaces that entry.
function importCsv(list, csv) {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw httpError(400, 'The file has no guest rows');
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([key, names]) => [key, columnIndex(rows[0], names)]));
  if (col.dealer < 0) throw httpError(400, 'The file needs a "Dealer" column');
  if (col.phone < 0 && col.email < 0) throw httpError(400, 'The file needs a "Mobile" or "E-mail" column');

  const guests = [...(list.guests || [])];
  const result = { added: 0, updated: 0, skipped: [] };
  rows.slice(1).forEach((r, i) => {
    const line = i + 2; // spreadsheet row number, counting the header
    const guest = {
      name: col.name >= 0 ? String(r[col.name] || '').trim().slice(0, 80) : '',
      phone: col.phone >= 0 ? normalizePhone(r[col.phone]) : '',
      email: col.email >= 0 ? normalizeEmail(r[col.email]) : '',
      dealer: String(r[col.dealer] || '').trim().slice(0, 80),
    };
    if (!guest.dealer) return result.skipped.push({ row: line, reason: 'no dealer' });
    if (!guest.phone && !guest.email) return result.skipped.push({ row: line, reason: 'no valid mobile number or e-mail' });
    const at = guests.findIndex((g) => (guest.phone && g.phone === guest.phone) || (guest.email && g.email === guest.email));
    if (at >= 0) {
      guests[at] = guest;
      result.updated++;
    } else {
      guests.push(guest);
      result.added++;
    }
  });
  return { list: { guests, updatedAt: Date.now() }, result };
}

// Mobile number is checked first, so it wins if the number and e-mail point to different dealers.
function findGuest(list, { phone, email }) {
  const guests = list.guests || [];
  const p = normalizePhone(phone);
  const e = normalizeEmail(email);
  return (p && guests.find((g) => g.phone === p)) || (e && guests.find((g) => g.email === e)) || null;
}

// Decided on the server, so what the browser sends can't claim or avoid an invitation.
function applyGuest(body, list) {
  const guest = findGuest(list, body);
  return guest ? { ...body, customerType: 'dealer', dealer: guest.dealer, guestMatched: true } : { ...body, guestMatched: false };
}

function summary(list) {
  const counts = {};
  for (const g of list.guests || []) counts[g.dealer] = (counts[g.dealer] || 0) + 1;
  return {
    count: (list.guests || []).length,
    updatedAt: list.updatedAt || null,
    dealers: Object.entries(counts).map(([dealer, count]) => ({ dealer, count })).sort((a, b) => b.count - a.count),
  };
}

module.exports = { importCsv, findGuest, applyGuest, summary };
