// Reads a driver's license photo through the GDS AI Gateway (OpenAI-compatible, vision-capable)
// and returns the fields we keep on the ticket. The photo is sent for extraction only — never stored.
// Env: GDS_API_KEY (required), GDS_BASE_URL (default below), LICENSE_MODEL (default gpt-6.1-sol).
const BASE_URL = (process.env.GDS_BASE_URL || 'https://ai-gateway.heineraboka.site/v1').replace(/\/$/, '');
const MODEL = process.env.LICENSE_MODEL || 'gpt-6.1-sol';
const TIMEOUT_MS = 25000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // decoded; the client downsizes to ~1280px so this is generous

const FIELDS_SCHEMA = {
  type: 'object',
  properties: {
    is_license: { type: 'boolean', description: "true if the image clearly shows a driver's license card" },
    name: { type: ['string', 'null'], description: 'Full name as printed, in "FIRST MIDDLE LAST" order' },
    license_number: { type: ['string', 'null'], description: 'License number exactly as printed, e.g. N01-23-456789' },
    expiry_date: { type: ['string', 'null'], description: 'Expiration date as YYYY-MM-DD' },
    birth_date: { type: ['string', 'null'], description: 'Date of birth as YYYY-MM-DD, if visible' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'How legible the key fields were' },
  },
  required: ['is_license', 'name', 'license_number', 'expiry_date', 'birth_date', 'confidence'],
  additionalProperties: false,
};

const SYSTEM = `You read photos of driver's licenses for a car showroom's test-drive check-in. Most cards are Philippine LTO licenses: the license number looks like "N01-23-456789" (letter, two digits, dash, two digits, dash, six digits). Dates on the card are printed as YYYY/MM/DD (year first, e.g. 2029/03/15) — the "Expiration Date" field is labelled as such and the "Date of Birth" is separate; do not confuse them: the expiry is the later date, usually 5 or 10 years after issue. Return every date as YYYY-MM-DD, keeping the same year, month and day order as printed. Transcribe exactly what is printed; if a field is unreadable or missing, return null rather than guessing. If the image is not a driver's license, set is_license to false and the other fields to null. Reply with JSON only.`;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// The gateway always answers as SSE (even with stream:false), so collect the deltas.
async function chatCompletion(body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GDS_API_KEY}` },
      body: JSON.stringify({ ...body, stream: true }),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      let msg = raw;
      try {
        msg = JSON.parse(raw).error || raw;
      } catch {}
      throw httpError(res.status === 401 || res.status === 403 ? 503 : 502, `License scan service error: ${String(msg).slice(0, 160)}`);
    }
    let full = '';
    for (const part of raw.split('\n\n')) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        full += JSON.parse(data).choices?.[0]?.delta?.content ?? '';
      } catch {}
    }
    return full;
  } catch (err) {
    if (err.name === 'AbortError') throw httpError(504, 'License scan timed out. Please try again.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function extractLicense({ image, mediaType }) {
  if (!process.env.GDS_API_KEY) throw httpError(503, 'License scanning is not set up yet (GDS_API_KEY missing)');
  if (!/^image\/(jpeg|png|webp)$/.test(mediaType || '')) throw httpError(400, 'Photo must be JPEG, PNG or WebP');
  const data = String(image || '').replace(/^data:[^;]+;base64,/, '');
  if (!data) throw httpError(400, 'No photo received');
  if ((data.length * 3) / 4 > MAX_IMAGE_BYTES) throw httpError(413, 'Photo is too large');

  const text = await chatCompletion({
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: "Extract the fields from this driver's license." },
          { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } },
        ],
      },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'license_fields', strict: true, schema: FIELDS_SCHEMA } },
    max_tokens: 400,
  });

  let out;
  try {
    out = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw httpError(502, 'Could not read the license. Please try again with a clearer photo.');
  }
  if (!out.is_license) throw httpError(422, "That doesn't look like a driver's license. Please take a photo of the front of the card.");

  // Accept 2029/03/15 or 2029-03-15 (as printed on the card) and normalise to 2029-03-15.
  const isoDate = (v) => {
    const m = String(v || '').match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})$/);
    return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
  };
  const expiry = isoDate(out.expiry_date);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: process.env.QUEUE_TZ || 'Asia/Manila' });
  return {
    name: out.name || null,
    licenseNumber: out.license_number ? String(out.license_number).toUpperCase().replace(/\s+/g, '') : null,
    expiry,
    birthDate: isoDate(out.birth_date),
    confidence: out.confidence || 'low',
    expired: expiry ? expiry < today : null,
  };
}

module.exports = { extractLicense };
