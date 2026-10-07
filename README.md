# Loans24 · Address verification

Customers verify their home or shop address from their phone. No agent visit needed.

| Page | URL | Who |
|---|---|---|
| Home page | `/` | Everyone |
| Login (mobile + OTP) | `/login` | Customers |
| My account: start / continue verifications | `/account/` | Customers |
| Capture flow (camera + GPS, 5 languages, voice) | `/v/#t=…` | Customers |
| Review console | `/admin/` | Your ops team |
| Privacy notice | `/privacy` | Everyone |

**Customer journey:** Home → Login with OTP → "Verify an address" → choose Home / Shop / Home office → type house no., area, city and pincode → the app finds the address on the map and shows it in words (**no latitude/longitude anywhere**) → "I'm at this address — start" → consent → 3 photos plus a short video → result.

---

## 🚀 Deploy to Vercel (step by step)

You need a free [Vercel](https://vercel.com) account and Node.js 24 installed.

### 1. Upload the project

Unzip the project, open a terminal in the folder, and run:

```bash
npm install
npx vercel login
npx vercel link
```

`vercel link` asks a few questions. Choose **"Create a new project"** and accept the defaults. `vercel.json` already contains all the settings.

### 2. Add a database (Postgres)

In the Vercel dashboard, open your project → **Storage** → **Create Database** → **Neon (Postgres)** → Free plan → **Connect**.
This automatically adds `DATABASE_URL`. The tables are created automatically on the first request.

### 3. Add photo storage

Same place: **Storage** → **Create** → **Blob** → **Connect** to your project.
This automatically adds `BLOB_READ_WRITE_TOKEN`.

### 4. Add the secrets

Go to **Project → Settings → Environment Variables** and add these for **Production**:

| Name | Value |
|---|---|
| `NODE_ENV` | `production` |
| `INTERNAL_API_KEY` | a random string (see command below) |
| `SESSION_SECRET` | another random string |
| `CRON_SECRET` | another random string |
| `SMS_PROVIDER` | `msg91` or `twilio` (see step 5) |

To generate each random string, run:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

> **Just want a demo first, with no SMS provider?** Add `ALLOW_CONSOLE_OTP` = `true` and leave out `SMS_PROVIDER`.
> The login code is then shown on screen. **Anyone can log in with any number, so never use this with real customers.**

### 5. SMS for login codes (real launch)

Indian law requires sending OTP SMS through a DLT-registered sender. The easiest route:
1. Create a [MSG91](https://msg91.com) account and complete DLT registration (sender ID plus an OTP template).
2. Add `SMS_PROVIDER=msg91`, `MSG91_AUTH_KEY` and `MSG91_TEMPLATE_ID`.

Twilio also works: `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`.

### 6. Deploy

```bash
npx vercel --prod
```

Open the URL Vercel prints. That's your live site. 🎉
To use your own domain, go to **Project → Settings → Domains**, then set `PUBLIC_BASE_URL=https://yourdomain.com` and redeploy.

### 7. Check it

- Open `https://<your-site>/api/healthz`. It should show `{"ok":true}`.
- On your phone, open the site, log in, verify an address, and take the photos.
- Open `https://<your-site>/admin/`, enter your name and `INTERNAL_API_KEY`, and you should see the verification.

> **Vercel limits to know:** each upload must be under 4.5 MB. The app compresses photos (~0.5 MB) and the video (~0.8 MB) to stay under it. The daily data-cleanup job runs at 03:00 IST via Vercel Cron.

---

## Run on your computer

```bash
npm install
cp .env.example .env     # Windows: copy .env.example .env  — then fill INTERNAL_API_KEY and SESSION_SECRET
npm start                # http://localhost:8080
```

No database setup is needed locally: an embedded Postgres is stored in `./data`. The login code appears on screen (demo mode).

```bash
npm test                 # unit tests
npm run smoke            # full end-to-end test against the running server
```

To test the camera on a phone, you need HTTPS. Either deploy to Vercel (preview deploys work: `npx vercel`), or run `npx cloudflared tunnel --url http://localhost:8080`.

---

## How addresses are found (no lat/lng for anyone)

- The customer types house/flat/shop no., area, city and pincode.
- The server looks the address up on the map:
  - **Default:** OpenStreetMap (free, no key, about 1 lookup per second). Fine for a pilot.
  - **Better for India at scale:** set `GOOGLE_MAPS_API_KEY`.
- The customer sees the address **in words** ("We found your address / your area") and confirms they are standing there.
- If the address only matches at area level, the allowed distance is widened (and noted as `GEO_APPROX`). If it can't be found at all, the case goes to manual review. **The customer is never blocked.**
- Reviewers see "📍 38 m from declared address" and a "View on map" link, not coordinates.

## How it decides

Each submission starts at 100 points, and each problem deducts points with a recorded reason:

- **≥ 80 and no fraud flag:** auto-accepted.
- **Fixable problem** (weak GPS, unreadable nameplate) **with retries left:** the customer is guided to retake.
- **Anything else:** manual review in `/admin/`. Customers are never auto-rejected. A reviewer must write a note to reject.

## Loan-system integration (optional)

Your loan system can create verifications directly and send the link by SMS/WhatsApp:

```http
POST /api/internal/sessions
X-API-Key: <INTERNAL_API_KEY>
{ "loanId": "LN-123", "applicantName": "Ramesh Sharma", "line1": "Flat 402, Shanti Apts",
  "area": "Andheri East", "city": "Mumbai", "pincode": "400069",
  "persona": "salaried | business | wfh", "assist": false, "lang": "hi" }
→ { "sessionId", "link", "expiresAt", "location": { "found": true, "label": "…" } }
```

Results are POSTed to `WEBHOOK_URL`, signed with `X-Signature: sha256=HMAC(body, WEBHOOK_SECRET)`.

---

## ⚠️ Before real customers use it

- [ ] **Compliance sign-off:** confirm that customer-led photo + GPS verification can replace a field visit under RBI Digital Lending / KYC rules.
- [ ] **Legal:** write the real privacy notice (`public/privacy.html` is a placeholder) and approve the consent text (`public/v/i18n.js`).
- [ ] **Native-speaker check** of the Hindi, Marathi, Tamil and Telugu text.
- [ ] **Real SMS provider** (MSG91/Twilio with DLT). Remove `ALLOW_CONSOLE_OTP`.
- [ ] **Photo storage:** Vercel Blob URLs are unguessable but public. For real customer data, move to a private bucket (e.g. AWS S3 Mumbai) by editing `server/storage.js`.
- [ ] **Review console login:** it currently uses a shared API key. Put `/admin` behind company SSO with per-reviewer accounts.
- [ ] **Map lookups:** add `GOOGLE_MAPS_API_KEY` before high volume (OpenStreetMap allows ~1 lookup per second).
- [ ] **Nameplate reading:** set `OCR_PROVIDER=google-vision` + `GOOGLE_VISION_API_KEY`.
- [ ] **Calibrate** the blur, lighting and distance thresholds on a few hundred real photos.
- [ ] **Security:** penetration test (VAPT), monitoring/alerts, and a pilot alongside physical visits.

## Project layout

```
api/index.js            Vercel serverless entry (all /api/* requests)
server/app.js           Express API: security headers, rate limits, routes
server/local.js         Local/self-hosted server (API + static pages)
server/routes/account.js   OTP login, my verifications, address check
server/routes/customer.js  Capture flow API (link token)
server/routes/internal.js  Loan-system + review console API
server/sessions.js      Verification lifecycle + submit pipeline
server/scoring.js       Decision engine (unit-tested)
server/checks/          Photo quality, GPS distance, map lookup, OCR
server/db.js            Postgres (Neon on Vercel / embedded PGlite locally)
server/storage.js       Vercel Blob / local disk
public/                 Home, login, account, capture app (/v), review console (/admin)
vercel.json             Routes, security headers, cron
```
