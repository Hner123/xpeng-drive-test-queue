// Shared helpers for all pages
const $ = (sel, root = document) => root.querySelector(sel);

async function api(path, { method = 'GET', body, pin } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (pin) headers['x-staff-pin'] = pin;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status, data });
  return data;
}

// Poll the queue every few seconds (works on static hosting with serverless functions, where a
// long-lived connection isn't available). onCall fires when a ticket newly becomes "called".
const POLL_MS = 3000;
function live(onUpdate, onCall) {
  let seen = null; // ticket id -> calledAt, from the previous poll
  let timer;
  async function tick() {
    try {
      const state = await api('/api/state');
      const now = new Map(state.tickets.filter((t) => t.status === 'called').map((t) => [t.number, t.calledAt]));
      if (seen && onCall) {
        for (const [id, calledAt] of now) {
          if (seen.get(id) !== calledAt) {
            const t = state.tickets.find((x) => x.number === id);
            onCall({ number: t.number, model: t.model, name: t.name });
          }
        }
      }
      seen = now;
      onUpdate(state);
    } catch {}
    timer = setTimeout(tick, document.hidden ? POLL_MS * 4 : POLL_MS);
  }
  tick();
  // catch up immediately when the tab becomes visible again
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      clearTimeout(timer);
      tick();
    }
  });
  return { refresh: () => { clearTimeout(timer); tick(); } };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function ago(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [880, 1318.5].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f;
      o.connect(g).connect(ctx.destination);
      const t = ctx.currentTime + i * 0.22;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.start(t);
      o.stop(t + 0.65);
    });
  } catch {}
}

function toast(msg) {
  let el = $('.toast');
  if (!el) document.body.append((el = Object.assign(document.createElement('div'), { className: 'toast' })));
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2400);
}

// Styled replacement for window.confirm(). Resolves true on confirm, false on cancel / Esc / backdrop click.
function confirmModal({ title, message = '', confirmText = 'Confirm', cancelText = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <h2 id="modal-title">${esc(title)}</h2>
        ${message ? `<p>${esc(message)}</p>` : ''}
        <div class="modal-actions">
          <button type="button" class="btn ghost" data-r="0">${esc(cancelText)}</button>
          <button type="button" class="btn ${danger ? 'btn-danger' : ''}" data-r="1">${esc(confirmText)}</button>
        </div>
      </div>`;
    const prevFocus = document.activeElement;
    function close(result) {
      document.removeEventListener('keydown', onKey);
      wrap.classList.remove('open');
      setTimeout(() => wrap.remove(), 180);
      prevFocus && prevFocus.focus && prevFocus.focus();
      resolve(result);
    }
    function onKey(e) {
      if (e.key === 'Escape') close(false);
    }
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) return close(false);
      const b = e.target.closest('[data-r]');
      if (b) close(b.dataset.r === '1');
    });
    document.addEventListener('keydown', onKey);
    document.body.append(wrap);
    requestAnimationFrame(() => wrap.classList.add('open'));
    $('[data-r="0"]', wrap).focus(); // safe default: Enter cancels
  });
}

// Dates are stored as 2029-03-15; show them the way the LTO card prints them: 2029/03/15
function cardDate(iso) {
  return iso ? String(iso).replace(/-/g, '/') : '';
}

const STATUS_LABEL = { waiting: 'Waiting', called: 'Now calling', driving: 'On test drive', done: 'Completed', noshow: 'No-show', cancelled: 'Cancelled' };
