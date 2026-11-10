# XPENG Test Drive Queue

Walk-in test drive queueing for the showroom. Runs two ways from the same code:

- **Netlify (public URL)** — static pages + a Netlify Function, queue stored in Netlify Blobs.
- **Local (showroom PC)** — `node server.js`, queue stored in `data/queue.json`. No install needed.

| Screen | Path | Who uses it |
|---|---|---|
| Kiosk / customer ticket | `/` | Customers pick L03 or X9, enter name + mobile, get a number (e.g. `X001`); page updates itself, ticket is printable |
| Staff console | `/staff` | Call next, start drive, finish, no-show, re-queue, remove (PIN protected) |
| Lobby display | `/display` | TV screen: now calling, up next, chime on each call; light/dark toggle |

## Deploy to Netlify

One-time:

```bash
npm install
```

```bash
npx netlify login
```

```bash
npx netlify init
```
(choose **Create & configure a new site**; accept the defaults — `netlify.toml` already has the build settings)

Then, every deploy:

```bash
npm run deploy
```

After the first deploy, set the staff PIN in the Netlify dashboard: **Site configuration → Environment variables → Add** `STAFF_PIN` (default is `1234` if unset), then redeploy.

Optional env vars: `QUEUE_TZ` (default `Asia/Manila`, controls when the daily numbering resets).

### SMS alerts

When staff press **Call next** (or **Call** / **Recall** on one customer), the server texts that customer once, using the Sales Team's wording ("Good day, {name}! … your Queue Number {number} is now being called. Kindly proceed to the XPENG Booth …"; edit it in `turnMessage` in `lib/notify.js`). Plain text, no links. No other texts are sent.

The call is saved first, so an SMS problem never blocks or undoes it. The staff console shows a badge next to the customer: *SMS sending…*, *SMS sent*, *SMS delivered*, *SMS failed* (hover for the reason; Recall retries), *No number* (not a valid PH mobile, nothing sent) or *SMS off* (no provider configured). A customer who was already texted is not texted again on Recall; Re-queue clears it so the next call texts again. After ~20 s the console asks the gateway whether the text was delivered.

Set **one** provider in Netlify's environment variables (then redeploy), or in `.env` for `node server.js` (`.env` is git-ignored and read by the server only):

| Provider | Variables | Notes |
|---|---|---|
| SMS Gateway for Android (cloud) | `SMS_GATEWAY_URL`, `SMS_GATEWAY_USER`, `SMS_GATEWAY_PASS`, `SMS_SIMS` | Current setup. `SMS_SIMS` = SIM slot(s), e.g. `2`, or `1,2` to alternate |
| Traccar SMS Gateway (Android phone, Cloud mode) | `TRACCAR_KEY` | Enable *Cloud service* in the app and copy its key |
| Semaphore (PH) | `SEMAPHORE_KEY`, optional `SEMAPHORE_SENDER` | ~₱0.50/SMS, needs account approval |

With none set, the app runs normally and SMS is skipped (badge *SMS off*). `SMS_PROVIDER=none` force-disables it.

### Driver's license scan

On the form, customers photograph their license; the photo is sent to the GDS AI Gateway (vision model) which returns the name, license number and expiry, and the form is filled in for them to confirm. Expired licenses are rejected at registration and flagged on the staff console.

The photo (downsized JPEG, ~200–400 KB) is kept with the registration: on Netlify in the `licenses` blob store keyed by ticket id, locally under `data/licenses/`. Only the staff console can open it (**View license** next to the customer, PIN-protected); it never appears in the public queue data. The waiver text tells customers the photo is kept. There is no automatic deletion — clear old photos from the Netlify Blobs UI (Site → Blobs → `licenses`) or the local folder as your retention policy requires.

Env vars: `GDS_API_KEY` (required — the `gds_live_…` virtual key), optional `GDS_BASE_URL` (default `https://ai-gateway.heineraboka.site/v1`) and `LICENSE_MODEL` (default `gpt-6.1-sol`). Without a key the scan button reports that scanning isn't set up and customers can type the details manually.

### Dealer guest list

Staff upload who each dealer invited from the staff console (**Upload list**, `.csv` or `.xlsx`; **Download template** gives the columns: Name, Mobile, E-mail, Dealer). Uploads add to the list, and a repeated mobile number or e-mail replaces its entry. The list is kept across days until cleared.

When a customer registers with a mobile number or e-mail on the list, the form fills in and locks "Invited by dealer" and the dealer name, and the server applies the same match when the ticket is created. Names are not matched. `/api/guest-lookup` is public so the form can react as they type, and returns the dealer name only.

### QR poster

`/qr` renders a printable "Scan to join the queue" poster whose code points at the site's own registration page. Print it or download the PNG from that page. It's also linked from the staff console.

### Test the Netlify version locally

```bash
npm run dev
```
Opens on `http://localhost:8888` with a local copy of the Blobs store.

## Run locally without Netlify

```bash
node server.js
```
Serves on port 3000. `PORT` and `STAFF_PIN` can be set as env vars, e.g. `$env:STAFF_PIN="9876"; node server.js`.

## Changing models / wait times

The `MODELS` list at the top of `lib/queue.js` holds the models, demo-car count (`units`) and average drive length (`minutes`). Est. wait = people waiting ÷ units × minutes. Car images are in `public/img/` (side-profile renders from xpeng.com's model menu).

## Data

Numbering restarts each day (showroom time). On Netlify each day is a separate key in the `queue` blob store; locally each past day is kept as `data/queue-YYYY-MM-DD.json`. Live updates are by polling every 3 s (`POLL_MS` in `public/common.js`).
