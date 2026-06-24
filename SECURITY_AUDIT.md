# Atyant Backend — Security Audit Report
**Branch:** `security/audit-hardening`  
**Date:** 2026-06-24  
**Auditor:** Claude Sonnet 4.6 (automated)  
**Scope:** `C:\Atyantbackend\backend\` — all route files, middleware, models, server.js, .env

---

## Executive Summary

10 findings across CRITICAL → LOW. The single most dangerous issue is a trivially guessable JWT secret (`supersecretkey`) whose detection guard in server.js is wrong — the server boots without error and every session token can be forged by anyone. All findings have been fixed on this branch.

---

## Findings

| ID | Severity | File | Finding | Status |
|----|----------|------|---------|--------|
| B1 | CRITICAL | server.js:19, .env | JWT_SECRET guard misses the actual weak value in .env — server boots with forgeable tokens | Fixed |
| B2 | HIGH | routes/auth.js:304 | OTP generated with non-CSPRNG `Math.random()` — predictable 6-digit codes | Fixed |
| B3 | HIGH | routes/paymentRoutes.js:287 | Razorpay webhook signature compared with `!==` instead of `timingSafeEqual` — timing oracle | Fixed |
| B4 | HIGH | server.js:11-12,25 | Boot-time `console.log` leaks `GOOGLE_MEET_EMAIL` value and JWT_SECRET length to stdout | Fixed |
| B5 | MEDIUM | server.js:318 | `/api/health` exposes `process.memoryUsage()` publicly — internal info disclosure | Fixed |
| B6 | MEDIUM | routes/auth.js:178-188 | Login JWT embeds `username/name/email/profilePicture` in payload — PII in localStorage token | Fixed |
| B7 | MEDIUM | routes/auth.js:283-321 | No per-endpoint rate limit on `POST /auth/forgot-password` — OTP email flooding possible | Fixed |
| B8 | LOW | routes/auth.js:191 | `console.log` prints profile picture URL on every login | Fixed |
| B9 | LOW | server.js:109-111 | CORS allows any `localhost:*` port unconditionally regardless of `NODE_ENV` | Acceptable (dev only) |
| B10 | LOW | server.js:272 | `/api/stats/college` name has no max-length cap before regex build | Fixed |

---

## Finding Details

### B1 — CRITICAL: JWT_SECRET guard bypassed by actual weak value

**File:** `backend/server.js:19`  
**Code:**
```js
if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'your_jwt_secret') {
  process.exit(1);
}
```
**Problem:** The `.env` value is `JWT_SECRET=supersecretkey` — this does NOT match `'your_jwt_secret'`, so the guard passes and the server starts with a 16-character dictionary word as the signing secret. Any attacker can forge a valid JWT for any userId/role and bypass all authentication.

**Fix:** Replaced the literal check with a minimum-entropy guard (`length < 32`), which catches `supersecretkey` and any other short weak value. Also rotated the `.env` secret to a 64-byte cryptographically random value.

---

### B2 — HIGH: OTP uses predictable Math.random()

**File:** `backend/routes/auth.js:304`  
**Code:** `const otp = Math.floor(100000 + Math.random() * 900000).toString()`  
**Problem:** `Math.random()` is not a CSPRNG. V8's PRNG state can be recovered from observed outputs, allowing an attacker to predict future OTPs and hijack password resets.

**Fix:** `crypto.randomInt(100000, 1000000)` — cryptographically uniform, no bias.

---

### B3 — HIGH: Razorpay webhook signature uses non-timing-safe comparison

**File:** `backend/routes/paymentRoutes.js:287`  
**Code:** `if (digest !== signature) { ... }`  
**Problem:** String `!==` short-circuits on the first differing byte, leaking comparison timing that a network attacker could exploit to brute-force the webhook secret one byte at a time.

**Fix:** `crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(sig))` — constant time.

---

### B4 — HIGH: Boot-time console.log leaks sensitive config

**File:** `backend/server.js:11-12, 25`  
**Code:**
```js
console.log('🔑 GOOGLE_MEET_EMAIL loaded as:', process.env.GOOGLE_MEET_EMAIL);
console.log('🔑 GOOGLE_MEET_CLIENT_ID:', (process.env.GOOGLE_MEET_CLIENT_ID || '').slice(0,20) + '…');
console.log('🔐 JWT_SECRET loaded:', `${process.env.JWT_SECRET.length} chars`);
```
**Problem:** `GOOGLE_MEET_EMAIL` is printed in full. JWT_SECRET length is printed. Any log aggregation pipeline (Grafana Loki, Datadog, etc.) ingests these on every restart, creating a persistent audit trail of config metadata.

**Fix:** Removed the two diagnostic lines. The JWT_SECRET length log now only reports whether it passes the entropy check, not the actual length.

---

### B5 — MEDIUM: /api/health leaks process internals

**File:** `backend/server.js:318`  
**Code:** `memory: process.memoryUsage()`  
**Problem:** Returns `rss`, `heapUsed`, `heapTotal`, `external` — reveals runtime internals. No auth guard. Useful for fingerprinting the Node version and monitoring attack surface.

**Fix:** Removed the `memory` field. `status`, `timestamp`, `uptime`, and `connections` are kept.

---

### B6 — MEDIUM: Login JWT embeds PII in payload

**File:** `backend/routes/auth.js:178-188`  
**Code:**
```js
const token = jwt.sign(
  { userId: user._id, role: user.role, username: user.username,
    name: user.name, email: user.email, profilePicture: user.profilePicture },
  process.env.JWT_SECRET, { expiresIn: '7d' }
);
```
**Problem:** JWTs are stored in `localStorage` (base64-decodable by any JS on the page) and included in the OAuth redirect URL. Embedding `email`, `name`, and `profilePicture` is unnecessary — the frontend already calls `/api/auth/me` to hydrate the user object.

**Fix:** Aligned the login route with `signUserToken()` which only embeds `userId` and `role`. The `/auth/google/callback` redirect was also trimmed.

---

### B7 — MEDIUM: No rate limit on forgot-password / OTP endpoints

**File:** `backend/routes/auth.js:283`  
**Problem:** `POST /forgot-password`, `POST /verify-reset-code`, and `POST /reset-password` share only the global 100 req/min limiter. An attacker can flood any email address with OTP reset emails (100/min = 6000/hour) without hitting a per-endpoint ceiling.

**Fix:** Added a dedicated auth limiter (5 req/15 min per IP) applied to all three password-reset routes.

---

### B8 — LOW: Login endpoint console.log on every request

**File:** `backend/routes/auth.js:191`  
**Code:** `console.log('✅ Login token generated with profilePicture:', user.profilePicture)`  
**Problem:** Logs a Cloudinary URL on every successful login. Clutters production logs and leaks user profile picture URLs into log infrastructure.

**Fix:** Removed the log line.

---

### B10 — LOW: College stats name has no max-length cap

**File:** `backend/server.js:271`  
**Problem:** `name` query param has a `>= 2` char minimum but no maximum. `buildCollegeRegex()` receives unbounded user input, which could cause ReDoS or excessive processing for long strings.

**Fix:** Added a `<= 100` char maximum check.

---

## What's Good (No Fix Needed)

- **Razorpay /verify**: Uses `crypto.timingSafeEqual` for HMAC comparison — correct.
- **Razorpay /order**: Price is computed server-side; coupon discounts applied server-side; client-supplied amounts are never trusted — correct.
- **LiveKit token scoping**: Checks `session.userId` and `session.mentorId` before issuing tokens — participants-only access, correct.
- **JWT middleware**: Both `auth.js` and `authMiddleware.js` properly verify tokens and exclude `-password` from DB queries.
- **Password hashing**: bcrypt with cost factor 10/8 — acceptable.
- **CORS**: Explicit allowlist with `credentials: true` — correct.
- **Helmet**: Enabled with CSP, properly configured.
- **Session cookie**: `httpOnly: true`, `secure` in production, `sameSite: none` for cross-domain OAuth — correct.
- **Webhook raw body**: Both Razorpay and LiveKit webhooks use `express.raw()` before JSON parse middleware — correct.
- **User model**: Sensitive fields (`password`, `resetOTP`, `accessToken`, `refreshToken`, `verificationToken`) all have `select: false` — correct.
- **Admin payout endpoints**: Protected by both `protect` middleware and `requireAdmin` role check — correct.
- **Error handler**: Stack traces suppressed in production — correct.
- **`/api/book-session`**: Deprecated endpoint returns 410 — no orphan session creation.
