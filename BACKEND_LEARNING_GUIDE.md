# Atyant Backend — Learning Guide (Basics → Advanced)

Goal: you can open any file in `backend/`, explain what it does, why it exists, and defend the design in an interview.

How to use this: read one module, then open the referenced file and read the real code. Do the "Prove you get it" task at the end of each module. Don't skip Module 1–3 even if they feel basic — every hard part later is built on them.

---

## Module 0 — What the product is (you must be able to say this in 30 seconds)

Atyant is a career-mentorship platform. A student books a paid 1:1 session with a mentor, the call happens on an in-house video meet, the call is recorded, transcribed by AI, turned into structured insights (summary, gaps, action items), and those insights are written back into the student's dashboard and roadmap. Around that core there's auth, chat, payments, subscriptions, an AI advisor ("Atyant"), a job-aggregation + auto-apply pipeline, and a TPO (college placement cell) dashboard.

**The backend is:** Node.js + Express + MongoDB (Mongoose) + Socket.IO, ~17k lines, deployed in Docker on a VPS alongside a self-hosted LiveKit server.

**Interview one-liner:** "It's a Node/Express + MongoDB backend with a real-time layer (Socket.IO), payment integration (Razorpay), self-hosted WebRTC (LiveKit) with server-side recording, and an async AI pipeline that transcribes and analyses every session."

---

## Module 1 — Node.js and the runtime model

### 1.1 What Node actually is
Node is a JavaScript runtime built on V8 with an event loop and non-blocking I/O. **One thread runs your JS.** Slow things (disk, network, DB) are handed off to the OS / thread pool, and your callback runs later when the result is ready.

Consequence you must internalise: **any CPU-heavy synchronous work blocks every user.** That's why in this codebase heavy things are either (a) sent to an external API (Groq, Razorpay, LiveKit), or (b) run as a detached async job that doesn't block the HTTP response.

Real example — `backend/routes/livekitRoutes.js:292`:
```js
sessionPipelineService.processSession(sessionId, audioPath).catch(err => ...)
res.sendStatus(200);
```
No `await`. The webhook replies to LiveKit in milliseconds; the multi-minute transcription runs in the background. If you `await`ed it, LiveKit would time out and retry the webhook, and you'd process the same recording repeatedly.

### 1.2 Event loop vocabulary you should be able to define
- **Blocking vs non-blocking** — `fs.readFileSync` blocks the loop; `fs.promises.readFile` doesn't.
- **Microtask vs macrotask** — promise `.then` callbacks (microtasks) run before `setTimeout` callbacks (macrotasks).
- **`unhandledRejection`** — a rejected promise nobody caught. Default in modern Node: crash the process.

Your code handles that explicitly at `backend/server.js:724`:
```js
process.on('unhandledRejection', (reason) => {
  console.error('🛑 Unhandled promise rejection (kept alive):', reason);
});
```
Be ready to defend this: *"A stray un-awaited SDK call shouldn't take the server down for every user. It's a safety net, not a substitute for fixing the source — the error is logged loudly."* An interviewer may push back that swallowing these can hide corruption; the correct answer is "yes, which is why it logs and we fix them, and in a bigger setup you'd log to Sentry and restart on repeated occurrences."

### 1.3 ES Modules vs CommonJS
`backend/package.json` has `"type": "module"`, so files use `import`/`export`, not `require`.

Critical gotcha, documented at `backend/server.js:4-8`: **`import` statements are hoisted and run before any other code in the file.** So a `dotenv.config()` call placed after imports runs too late — modules that read `process.env` at load time (like `emailService.js` reading `RESEND_API_KEY`) would see `undefined`. The fix used here is `import 'dotenv/config'` as the *first* import, so it loads as a side-effect before the rest.

That's a genuinely good interview story: "ESM hoisting broke our env loading; we fixed it by loading dotenv as a side-effect import."

### 1.4 Fail-fast configuration
`backend/server.js:19-24` refuses to boot if `JWT_SECRET` is missing or is the placeholder value. Same for `MONGO_URI` at line 200.

Why this matters: without it, login *appears* to work but every authenticated request 401s — the classic "works locally, breaks in prod" bug. Crashing at deploy time surfaces the misconfiguration to you instead of to users.

**Prove you get it:** find one other place in the codebase where a failure is deliberately made loud instead of silent.

---

## Module 2 — Express: routing and middleware

### 2.1 The mental model
Express is a pipeline. A request enters and passes through an ordered list of functions:

```js
(req, res, next) => { /* do something */ next(); }
```

Each one can: modify `req`/`res`, end the response, or call `next()` to pass control on. **Order is everything.**

### 2.2 Read `server.js` top to bottom as a pipeline
This is the single most valuable exercise in this guide. In order (`backend/server.js`):

| Line | Middleware | What it does |
|---|---|---|
| 86 | `express.static` | Serves `/uploads` files from disk |
| 90 | `compression` | Gzips responses |
| 142 | `cors` | Cross-origin access control |
| 172 | `helmet` | Security response headers + CSP |
| 179 | `cookieParser` | Parses `Cookie` header into `req.cookies` |
| 182 | `express.json` (conditional) | Parses JSON bodies |
| 189 | custom | Cache-Control headers |
| 228 | `globalRateLimit` | Rate limiting |
| 234 | `express-session` | Session cookie, stored in Mongo |
| 250 | `passport` | OAuth |
| 254+ | routers | Actual endpoints |
| 285 | `errorHandler` | Centralised error handling |

Two of these have non-obvious conditional logic. Learn both — they're great interview material.

### 2.3 Why compression is skipped for one endpoint
`backend/server.js:90-101`:
```js
if (req.originalUrl === '/api/ai/atyant-chat' && req.method === 'POST') return false;
```
That endpoint streams **SSE (Server-Sent Events)** progress checkpoints. Gzip buffers output to compress it efficiently — which defeats streaming, because chunks sit in the buffer instead of reaching the browser immediately. So compression is disabled for that route only.

Note the comment on why it uses `req.originalUrl` and not `req.path`: the filter runs lazily on the first `res.write`, by which time Express's router has already rewritten `req.path` relative to the mount point. `originalUrl` stays the full path.

### 2.4 Why JSON parsing is skipped for webhooks
`backend/server.js:182-186`:
```js
if (req.originalUrl === '/api/payments/webhook') return next();
if (req.originalUrl === '/api/livekit/webhook') return next();
return express.json({ limit: '10mb' })(req, res, next);
```

**This is a top-tier interview answer.** Webhook signatures are HMACs computed over the *exact raw bytes* the sender transmitted. If you parse the JSON and re-serialise it, whitespace and key order can change, and the signature check fails. So those two routes need the raw `Buffer`, which they get via `express.raw(...)` in their own router (`paymentRoutes.js:319`, `livekitRoutes.js:199`).

Note the LiveKit one uses `express.raw({ type: () => true })` — LiveKit sends `Content-Type: application/webhook+json`, so `type: 'application/json'` would skip the body entirely and break the sha256 check.

### 2.5 Routers
Each feature gets a router file mounted under a prefix (`backend/server.js:254-270`). Inside a router, paths are relative to the mount point: `router.post('/order')` in `paymentRoutes.js` becomes `POST /api/payments/order`.

Full API surface (16 routers): `auth`, `profile`, `clarity`, `sessions`, `payments`, `subscriptions`, `saved-answers`, `roadmap`, `ai`, `mentor`, `share`, `feedback`, `livekit`, `tpo`, `jobs`, chat.

### 2.6 Error handling
An Express **error-handling middleware** has four arguments: `(err, req, res, next)`. Express identifies it by arity. You reach it by calling `next(err)` or by throwing in a sync handler.

Rough edge worth knowing (and worth being honest about): `app.use(errorHandler)` sits at `server.js:285`, but several routes are registered *after* it (lines 289–441). Express error middleware is positional, so errors from those later routes don't reach it. They happen to be safe because each has its own `try/catch`. **If an interviewer asks "what would you improve?", this is a clean, specific answer:** move `errorHandler` to be the last `app.use` after all routes.

Second rough edge: in async handlers, a thrown error does *not* automatically reach the error middleware in Express 4 — you must `try/catch` and `next(err)`. This codebase consistently uses `try/catch` in every async route, which is why it works.

**Prove you get it:** explain why moving `app.use(cors(...))` to after the routers would break the frontend.

---

## Module 3 — MongoDB and Mongoose

### 3.1 Document model
MongoDB stores JSON-like documents in collections. No joins in the SQL sense; you either embed related data in a document or store a reference (`ObjectId`) and resolve it.

Mongoose adds schemas, validation, middleware, and query building on top.

### 3.2 Read a real schema: `backend/models/Session.js`
Only 103 lines and it teaches most of Mongoose. Things to notice:

**Field types and constraints:**
```js
status: { type: String, enum: ['pending','upcoming','completed','cancelled'], default: 'upcoming', index: true }
```
`enum` is validation; invalid values are rejected on save. `index: true` builds a database index on that field.

**References:**
```js
userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }
```
`ref: 'User'` lets you call `.populate('userId')` to fetch the full user document in a follow-up query.

**Nested objects** — `review`, `mentorFeedback`, `remindersSent` group related fields.

**`{ timestamps: true }`** (line 95) auto-adds `createdAt` / `updatedAt`.

**Compound indexes:**
```js
sessionSchema.index({ payoutStatus: 1, mentorId: 1 });
sessionSchema.index({ userId: 1, status: 1, scheduledAt: -1 });
```

### 3.3 Indexes — understand this properly
An index is a sorted data structure that lets MongoDB find documents without scanning the whole collection. Without one, a query on 100k sessions reads all 100k documents.

**Compound index rule (the "prefix rule"):** an index on `{userId, status, scheduledAt}` can serve queries on `userId`, or `userId+status`, or all three — but **not** a query on `status` alone. Order matters: equality fields first, range/sort fields last.

Look at `{ userId: 1, status: 1, scheduledAt: -1 }` and the query it serves ("my upcoming sessions, newest first"). That's textbook ESR (Equality, Sort, Range) design and you should be able to explain it.

`{ payoutStatus: 1, mentorId: 1 }` exists so the month-end mentor payout run is a single indexed query instead of a collection scan.

### 3.4 `.lean()` — know why it's everywhere
```js
const user = await User.findById(id).select('-password').lean();
```
By default Mongoose returns full documents with change tracking, getters, and `.save()`. `.lean()` returns plain JavaScript objects instead — **significantly faster and lower memory**, because none of that machinery is constructed.

Rule: use `.lean()` for reads you'll only serialise to JSON. Don't use it when you need to mutate and `.save()`.

Notice `paymentRoutes.js:253` deliberately does *not* use `.lean()` — that session gets mutated and saved.

### 3.5 `.select()` and projection
```js
.select('-password -passwordResetToken -verificationToken')
```
Excludes fields. `.select('name email')` includes only those. **Never return password hashes over the API**, even though bcrypt hashes aren't trivially reversible — they're still crackable offline.

Some fields in `User.js` are declared `select: false` (e.g. `verificationToken`, `passwordResetToken`) so they're excluded by default unless explicitly requested.

### 3.6 Atomic operators
```js
User.findByIdAndUpdate(sender._id, { $inc: { messageCredits: -1 } })
```
(`server.js:564`) `$inc` is atomic **at the database level**. The alternative — read, subtract in JS, write back — has a race condition: two concurrent messages both read 5, both write 4, and the user got a free message.

Other operators used here: `$push`, `$pull`, `$setOnInsert`, `$or`, `$nin`, `$lt`, `$exists`.

### 3.7 Upsert
```js
SessionTranscript.findOneAndUpdate({ sessionId }, {...}, { upsert: true, new: true })
```
Insert if not found, update if found. Makes the pipeline **idempotent** — re-running it replaces the transcript instead of creating a duplicate. `new: true` returns the post-update document.

### 3.8 Connection tuning
`backend/server.js:206-211`:
```js
maxPoolSize: 10, serverSelectionTimeoutMS: 30000, socketTimeoutMS: 45000
```
Mongoose keeps a **connection pool** — reusing up to 10 TCP connections rather than opening one per query. The timeouts prevent requests hanging forever when Mongo is unreachable.

**Prove you get it:** write the index you'd add to make `Message.find({sender, receiver}).sort({createdAt:-1})` fast, and explain field order.

---

## Module 4 — Authentication and authorisation

### 4.1 Password storage
`bcryptjs` hashes passwords. Key properties: **salted** (same password → different hashes, so rainbow tables fail) and **deliberately slow** (a work factor makes brute force expensive). Never MD5/SHA — those are fast, which is exactly wrong for passwords.

### 4.2 JWT — what it actually is
A JSON Web Token is three base64url parts: `header.payload.signature`.

- Payload holds claims (here: `userId`, expiry).
- Signature = HMAC-SHA256 of `header.payload` using `JWT_SECRET`.

**Critical understanding: the payload is encoded, not encrypted.** Anyone can decode and read it. The signature only guarantees it wasn't *modified*. So: never put secrets in a JWT.

**Stateless auth:** the server doesn't store sessions — it verifies the signature. Advantage: horizontally scalable. Disadvantage: **you can't revoke a token before it expires.** Be ready for that question; the mitigation is short expiry + a refresh flow, or a revocation list (which reintroduces state).

### 4.3 The two middlewares — know the difference
`backend/middleware/auth.js`:

**`auth` / `protect` (required)** — reads the token from the `Authorization: Bearer` header *or* the `token` cookie, verifies it, loads the user from Mongo, sets `req.user`, and 401s if anything fails. Note it distinguishes `JsonWebTokenError` (invalid) from `TokenExpiredError` (expired) — the frontend uses that to decide between "log in again" and "refresh".

**`optionalAuth`** (line 68) — same, but on *any* failure it sets `req.user = null` and calls `next()` anyway. Used for endpoints that work for guests but personalise for logged-in users (mentor search, AI chat, roadmap generation).

Inconsistency worth noticing (and a good "what would you fix" answer): `optionalAuth` only reads the `Authorization` header, not the cookie, while `auth` reads both. A cookie-authenticated user hits an `optionalAuth` route as a guest.

### 4.4 Google OAuth 2.0
`backend/config/passport.js` + `routes/auth.js:1079-1114`. The flow:

1. `GET /auth/google` → redirect user to Google
2. User authenticates with Google (your server never sees the password)
3. Google redirects back to `/auth/google/callback` with a code
4. Server exchanges the code for tokens, gets the profile, finds-or-creates the user, issues **your own JWT**

Why sessions exist alongside JWT: Passport's OAuth handshake needs to correlate the redirect back with the initiating request, which needs server-side state. Hence `express-session` with `connect-mongo` (`server.js:234-248`) — sessions in MongoDB, not memory, so they survive restarts and work across multiple server processes.

### 4.5 Cookie security flags
`backend/server.js:242-247`:
```js
secure:   NODE_ENV === 'production',              // HTTPS only
httpOnly: true,                                   // JavaScript cannot read it
sameSite: NODE_ENV === 'production' ? 'none' : 'lax'
```
- `httpOnly` blocks XSS from stealing the token via `document.cookie`.
- `secure` prevents transmission over plain HTTP.
- `sameSite: 'none'` is required because the frontend (`atyant.in` / Vercel) is a different origin from the API. `'none'` **requires** `secure: true`. In dev, `lax` because localhost isn't HTTPS.

### 4.6 Role-based authorisation
Roles: `user`, `mentor`, `admin` (`User.js:374`), plus a TPO role for the college dashboard.

Authorisation is checked two ways:
- **Role middleware** — `tpoOnly` (`tpoRoutes.js`), `requireAdmin` (`paymentRoutes.js:422`)
- **Ownership checks** — `livekitRoutes.js:126-131`:
```js
const isStudent = session.userId.toString() === userId;
const isMentor  = session.mentorId?.toString() === userId;
if (!isStudent && !isMentor) return res.status(403).json({...});
```

Learn the distinction: **authentication = who you are (401), authorisation = what you may do (403).**

Note `.toString()` — comparing an `ObjectId` to a string with `===` is always false. Classic bug source.

**Prove you get it:** explain why `optionalAuth` swallowing errors is safe here but would be a vulnerability if it were used on `/api/payments/order`.

---

## Module 5 — Real-time with Socket.IO

### 5.1 WebSockets vs HTTP
HTTP is request/response — the server can't initiate. WebSocket is a persistent, bidirectional connection after an HTTP upgrade handshake. Socket.IO adds reconnection, rooms, fallback to long-polling, and an event API on top.

`backend/server.js:448-455`:
```js
transports: ['websocket', 'polling'], pingTimeout: 60000, pingInterval: 25000
```
Heartbeats: the server pings every 25s; if no pong within 60s, the socket is considered dead. Polling is the fallback for networks that block WebSocket.

### 5.2 Authenticating a socket
`backend/server.js:458-481`. This is the part interviewers probe.

`io.use(...)` is socket middleware, run once at connection. It pulls the JWT from three places (handshake auth object, `Authorization` header, or a manually parsed cookie), verifies it, and attaches `socket.user`. No token → connection refused.

Then the crucial line at `server.js:492-496`:
```js
socket.on('join_user_room', userId => {
  // Ignore client-supplied userId and use verified JWT identity
  const socketUserId = socket.user?.userId;
```
**The client sends a `userId` and the server deliberately ignores it,** using the JWT-verified identity instead. Otherwise anyone could join another user's room and read their messages. Be able to state this attack and the fix — it's a real authorisation bug class (IDOR).

### 5.3 Rooms
`socket.join(currentUserId)` puts the socket in a room named after the user id. Then `io.to(userId).emit(...)` delivers to every device that user has open. Simple, effective 1:1 routing.

### 5.4 The message flow — trace it end to end
`backend/server.js:521-665`, the `private_message` handler. Order of operations:

1. Validate non-empty
2. **Content moderation** (`utils/ContentModerator.js`) — reject or clean
3. Load sender + receiver **in parallel** with `Promise.all`
4. Business rules: mentor accepting messages? sender has credits?
5. Persist the message
6. Deduct a credit atomically with `$inc` — **not awaited**, deliberately (`server.js:564`)
7. If it's the first message in the conversation, increment mentor `totalChats`
8. Populate sender/receiver, reshape into a frontend-friendly payload
9. Emit to **both** receiver and sender (so the sender's other devices update)
10. Mark delivered if the receiver has a live socket
11. Emit a notification once per conversation (deduped via `pendingNotifications`)
12. Auto-reply if user→mentor (delayed 1.5s so it feels human)
13. Email the receiver **only if they're offline and not already notified**

Points 10–13 are the interesting design: three in-memory `Map`s track presence (`activeUsers`, `userSockets`, `pendingNotifications`) so you don't spam someone with an email for a message they're actively reading.

### 5.5 The scaling limitation — know it before you're asked
Those `Map`s are **per-process, in memory**. With two server instances behind a load balancer:
- `io.to(userId)` only reaches sockets on *that* instance
- presence data is split and wrong

The standard fix is the **Socket.IO Redis adapter**, which broadcasts events across instances via Redis pub/sub, plus moving presence into Redis.

Saying "this is single-instance by design; scaling out needs the Redis adapter" shows real understanding. Claiming it scales as-is does the opposite.

Also note `Promise.all` in step 3 — two independent queries run concurrently instead of sequentially. Easy latency win worth mentioning.

**Prove you get it:** describe exactly what breaks, from the user's point of view, if you run two instances of this server today.

---

## Module 6 — Payments (Razorpay)

Money code is the most scrutinised part of any backend. Learn this module properly.

### 6.1 The three-step flow
`backend/routes/paymentRoutes.js`:

**Step 1 — `POST /order` (line 115).** Server-side validation *before* taking money:
- date/time parse, reject past bookings
- **double-booking check** (line 128) — reject if the slot is taken, with a different message depending on whether it's the user's own booking
- verify the mentor exists and actually offers that service
- **price is resolved server-side from the service catalog, never from the request body** (line 153)
- coupon discount applied **server-side** (line 166)
- reject ₹0 base prices instead of silently confirming a free booking (line 161)

Then create the Razorpay order and a `Session` with `status: 'pending'`, `paymentStatus: 'created'`.

**The price rule is the single most important thing here.** If the client could send `amount`, users would pay ₹1 for a ₹500 session. Same for coupons. Say this out loud in an interview.

**Step 2 — `POST /verify` (line 246).** After Razorpay's checkout succeeds, the client posts back the order id, payment id, and signature.
1. **Idempotency check** (line 259) — already `paid`? return success, don't double-process
2. **Verify the HMAC signature, timing-safe** (line 264)
3. **Independently fetch the payment from Razorpay** and confirm `status === 'captured'` (line 272)
4. Only then mark paid, compute the mentor's share, create the meet link, send emails

Step 3 is the subtle one: signature verification proves the message came from Razorpay, but the extra fetch proves the money was actually captured. Defence in depth.

**Step 3 — `POST /webhook` (line 319).** Razorpay calls this server-to-server. It's the **safety net**: if the user closes the tab before `/verify` runs, the webhook still confirms the booking. It verifies its own HMAC over the raw body (line 325) and checks `paymentStatus !== 'paid'` before acting — so `/verify` and the webhook can both fire without double-processing.

### 6.2 Concepts to be able to define
- **HMAC** — hash of the message keyed with a shared secret. Proves authenticity + integrity. Only Razorpay and you know the secret.
- **Timing-safe comparison** — comparing secrets with `===` leaks information through how long the comparison takes (it exits at the first differing byte). `crypto.timingSafeEqual` always takes the same time.
- **Idempotency** — the same operation applied twice has the same effect as once. Essential for webhooks, which retry on non-2xx.
- **Why webhooks exist** — the client is untrusted and unreliable (closed tabs, dead networks). The server-to-server callback is the source of truth.

### 6.3 The payout ledger
`backend/models/Session.js:67-74`. Money is collected centrally, then paid out to mentors monthly:
```js
mentorShare, platformFeePct, payoutStatus, payoutBatchId, paidOutAt
```
With `sessionSchema.index({ payoutStatus: 1, mentorId: 1 })`, the month-end run is one indexed query. `payoutBatchId` groups everything settled together so a batch can be audited or reversed.

Admin endpoints: `GET /payouts/pending`, `POST /payouts/settle` — both behind `requireAdmin`.

### 6.4 Retired endpoints
`backend/server.js:277-282` — the old `POST /api/book-session` returns **410 Gone** with an explanation, because it used to create sessions with no payment and no user id (orphan records, ₹0 collected). Returning 410 instead of deleting the route makes stale clients fail loudly rather than silently faking a confirmed booking.

Good lesson: **deprecate loudly.**

**Prove you get it:** an attacker replays a valid `/verify` request 50 times. Walk through what happens and name the line that stops it.

---

## Module 7 — Video meet + recording (LiveKit)

This is the hardest part of the codebase and the best interview material, because it's full of real distributed-systems problems you actually hit in production.

### 7.1 Background
WebRTC gives browsers peer-to-peer audio/video. An **SFU** (Selective Forwarding Unit) sits in the middle and routes streams — needed for more than 2 participants and for server-side recording. **LiveKit** is the open-source SFU, self-hosted here on the same VPS.

**Egress** is LiveKit's recording component: it joins the room as a hidden participant and writes the mixed audio to a file.

### 7.2 Joining a call
`backend/routes/livekitRoutes.js:116`:
1. Verify the caller is the student or mentor of *this* session (403 otherwise)
2. `createRoom` — **idempotent**, re-creates the room if LiveKit reclaimed it after `emptyTimeout` (this was the cause of "requested room does not exist" egress failures)
3. Generate a scoped LiveKit access token — mentor gets `admin`, student gets `participant`
4. `ensureEgress` — start recording
5. Return the token; the browser connects directly to LiveKit with it

### 7.3 The atomic egress claim — study this
`backend/routes/livekitRoutes.js:43-52`:
```js
const session = await Session.findOneAndUpdate(
  {
    _id: sessionId,
    egressId: null,
    $or: [{ egressAttempts: { $lt: MAX_EGRESS_ATTEMPTS } }, { egressAttempts: { $exists: false } }],
  },
  { $inc: { egressAttempts: 1 } },
  { new: true }
);
if (!session) return null;
```

**What's happening:** `ensureEgress` is called from several places that can fire at the same time — the join request, the `participant_joined` webhook, the `track_published` webhook. Without protection, three callers would each start a recording.

The filter conditions and the increment happen in **one atomic database operation**. Exactly one caller matches `egressId: null` and wins; the rest get `null` back and no-op. This is **optimistic concurrency control via a conditional update** — the same idea as compare-and-swap.

The attempt cap (`MAX_EGRESS_ATTEMPTS = 3`) means a persistently broken LiveKit can't cause an infinite retry loop.

If you learn one thing from this codebase for interviews, learn this pattern. "How do you prevent a race when multiple events can trigger the same one-time action?" → "Conditional atomic update; the filter is the lock."

### 7.4 Verifying the recording actually started
`livekitRoutes.js:83-106`. LiveKit accepting an egress (returning an `egressId`) does **not** mean recording began. Under CPU pressure the egress worker never reports "started" and the job dies ABORTED — this silently killed **23% of sessions in the July pilot**.

The fix: after 20s, poll the egress status. Still STARTING? Wait one more window (don't kill a slow-but-working worker). If it's FAILED/ABORTED/stuck, kill the dead job, clear `egressId`, and — **only if someone is still on the call** — start a fresh one.

Design principle stated in the comment: **partial audio beats losing the whole session.**

Why not just wait for the `egress_ended` webhook? A dead worker may never send one. **Never rely solely on a failure signal from the thing that failed.** Active verification with a timeout.

### 7.5 The reconnect grace period
`livekitRoutes.js:237-262`. When `participant_left` fires and no humans remain, the naive move is to close the room immediately. That's wrong: **a weak-network drop fires `participant_left` even though the user is about to reconnect.** Closing instantly destroyed the room and orphaned the egress, fragmenting recordings — only the first ~30 seconds survived.

Fix: wait `EMPTY_ROOM_GRACE_MS` (5 min, matched to LiveKit's own `departureTimeout` so both agree), then re-check. Reconnecting users rejoin the *same* room instance, so egress keeps recording.

The generalisable lesson: **in distributed systems, "gone" is often "temporarily unreachable." Confirm before acting destructively.**

Note `roomHasParticipants` excludes the hidden egress participant — otherwise the room would never look empty and would record silence forever.

### 7.6 Webhook events handled
- `participant_joined` / `track_published` → `ensureEgress` (retry path)
- `participant_left` → delayed empty-room check
- `room_finished` → mark session completed, force-stop any stuck egress
- `egress_ended` → if the file exists and has size > 0, kick off the AI pipeline; otherwise record *why* it failed on the session and possibly restart

That last branch (`livekitRoutes.js:295-313`) is worth noting: `pipelineError` stores the reason **in the database**, so failures are debuggable from Mongo without SSH-ing into the VPS to read Docker logs. Observability by design.

### 7.7 The shared volume
Egress writes the `.ogg` to `/tmp/recordings`; the backend reads it from the same path. They're different containers, so this only works because a **Docker volume is mounted into both** (`RECORDINGS_PATH`). A path mismatch here means "file not found" at pipeline time — and the code says so explicitly in the error message (`SessionPipelineService.js:215`).

**Prove you get it:** the join request and two webhooks fire `ensureEgress` within 200ms of each other. Trace what each call returns and why only one recording starts.

---

## Module 8 — The AI session pipeline

`backend/services/SessionPipelineService.js` — 650 lines and the most sophisticated file in the repo. Read it fully, twice.

### 8.1 What it does
`egress_ended` webhook → audio file → **Whisper transcription** (Groq) → **LLM insight extraction** (Llama 3.3 70B) → persist transcript + insights → write cards into the student's dashboard and roadmap.

### 8.2 The serial queue
`SessionPipelineService.js:43-47`:
```js
async processSession(sessionId, audioPath) {
  this._queue = (this._queue ?? Promise.resolve())
    .then(() => this._process(sessionId, audioPath));
  return this._queue;
}
```

A promise chain used as a **one-at-a-time job queue**. Each new job appends to the tail of the chain.

Why: a pilot batch ends 20 sessions within minutes. Twenty parallel pipelines would blow through Groq's per-minute rate limit and 429 each other into `failed`. Serialising trades latency for reliability.

Note the comment "`_process` never throws — safe to chain." That's load-bearing: if `_process` could reject, the chain would break and every subsequent job would be skipped. Understand *why* that matters — it's a subtle promise-chain trap.

### 8.3 Ordering that survives failure
Original bug: transcript and insights were saved together at the end, so an insight failure **discarded a perfectly good transcript** (an 88-minute recording was lost this way on July 6).

Fix (`SessionPipelineService.js:60-70`): persist the transcript **immediately** after transcription, before insight extraction.

Consequence: `/reprocess` can rebuild insights from the stored transcript even after the audio file has been reaped (lines 71-85). That's why the recovery path exists.

**Principle: save intermediate results at each stage; don't make step N's failure destroy step N-1's output.**

### 8.4 Long-audio handling
Groq's Whisper rejects files over 25 MB. Files above `GROQ_MAX_BYTES` (23 MB, kept 2 MB under the hard limit) are split by **ffmpeg** into 20-minute chunks (`_transcribeSplitAudio`, line 318):
1. `ffprobe` for total duration
2. `ffmpeg -ss -t -c copy` to cut chunks (stream copy, no re-encode — fast)
3. Transcribe each chunk
4. **Stitch, offsetting each segment's timestamps by the chunk's start** (line 368) — otherwise every chunk's timestamps would start at 0
5. 3s pause between uploads to avoid rate limits
6. `finally` block always cleans up temp files (line 378)

### 8.5 Long-transcript handling: map-reduce
The token limit problem. Original code did `transcriptText.slice(0, 24000)`, which **silently dropped everything past ~40 minutes** — including the end of the session, where action items and next steps actually live.

Fix (`_extractInsightsSmart`, line 406):
- **Map:** split into 20k-char chunks, ask the LLM for condensed structured notes on each
- **Reduce:** merge all the notes into one final full-schema analysis
- 15s spacing between chunk calls to stay under the free-tier tokens-per-minute cap

This is genuinely good LLM engineering and a strong thing to explain. Name it: "map-reduce summarisation over a context window limit."

### 8.6 Detecting dead-mic recordings
`_isLowContent`, line 234. **Whisper hallucinates on silence** — it pads with "you / thank you / hello" loops. Without a check, a session where the mic never worked would get a **fabricated summary** on the student's dashboard.

The first attempt used a unique-words-to-total-words ratio. That produced a false positive: a rich 88-minute session with heavy interspersed filler scored low and got wrongly rejected, hiding a real 34k-char session whose audio was fine.

The current approach: **strip the known filler words, then measure how much real content remains.** A genuine conversation keeps thousands of characters and hundreds of distinct words even when heavily padded; a dead-mic recording has almost nothing left.

```js
return cleaned.length < 500 || uniqueReal < 50;
```

And when it *does* trigger, it doesn't just fail — it writes an honest insight explaining the likely causes (muted mic, permissions, device) and still saves it to the dashboard so the session doesn't silently vanish (lines 100-134).

**Principle: never fabricate output for the user. Fail visibly and explain.** That's a strong thing to say in an interview about AI products.

### 8.7 Retry logic
`_withRetry`, line 252. Retries **only transient failures** — 429, 5xx, timeouts, network errors. Non-retryable errors (bad file, bad API key) fail immediately instead of wasting three minutes.
```js
const wait = 60000 * (i + 1);   // 60s, then 120s
```
The backoff is long specifically because it's waiting for Groq's per-minute token bucket to refill.

Know the vocabulary: **exponential backoff**, **transient vs permanent failure**, **jitter** (not used here; you'd add it if many clients retried simultaneously — the thundering-herd problem).

### 8.8 Defensive normalisation
`_normalizeInsights`, line 522. LLMs return inconsistent JSON shapes: a field specified as an array sometimes comes back as a bare string, or is missing entirely. Downstream code calls `.map()` / `.slice()` on it and crashes.

The fix coerces every field to its expected type. `strArr` handles both plain strings and `{point: "..."}` objects.

**Principle: treat LLM output as untrusted input.** Validate and coerce at the boundary. (A stricter version of this would use the `zod` schemas already in the project's dependencies.)

### 8.9 API key rotation
`utils/groqClient.js` exports `groqRotate` and `GROQ_API_KEYS` — multiple keys with failover, so one key hitting its limit doesn't stop the pipeline. `groqJSON` requests JSON mode so the model returns parseable JSON.

Note the guard at `SessionPipelineService.js:149`: `groqJSON` returns `{}` on a parse failure, so a fully-empty result is treated as an **error** (retryable via `/reprocess`) rather than stored as a blank insight that renders as an empty dashboard card.

### 8.10 Writing back to the dashboard
`_saveToUserDashboard`, line 548:
- **First, `SavedAnswer.deleteMany({ sessionId })`** — so a `/reprocess` run replaces its own earlier writes instead of stacking duplicates. This is what makes reprocessing idempotent.
- Session summary → one `SavedAnswer` card
- Each student action item → its own `SavedAnswer`
- A new phase in the student's `Roadmap`, built from action items + gaps + next-session prep
- `$pull` then `$push` on the roadmap step, so a reprocess replaces rather than appends
- `upsert: true` so students who never generated a roadmap still get one

And the whole write block is wrapped so a failure here is logged as **non-fatal** — the transcript and insights are already safely persisted.

### 8.11 Recording retention
Explicitly documented at line 201: the `.ogg` is **never deleted by the app**, on success or failure. A VPS cron reaps `/tmp/recordings` after 48h. Deleting on failure was the bug that made a completed 57-minute recording unrecoverable the one time transcription errored.

**Prove you get it:** a 75-minute session produces a 30 MB file and a 55k-char transcript. List every branch it takes through this service, in order.

---

## Module 9 — Background jobs (cron)

`backend/server.js:214-218` — five cron services start **after** the Mongo connection resolves, not at import time. Order matters: a job that fires before the DB is up would throw.

| Service | Job |
|---|---|
| `ReminderCron` | 24h / 1h session reminder emails |
| `TranscriptRecoveryCron` | Retry sessions whose pipeline failed |
| `StalePendingCron` | Clean up `pending` sessions where payment never completed |
| `JobSyncCron` | Pull jobs from ATS providers |
| `AutoApplyCron` | Run auto-applications |

**Duplicate-send prevention:** `Session.remindersSent.email24h` / `.email1h` booleans (`Session.js:53-56`). The cron sets the flag when it sends. Without this, a cron running every 15 minutes would email the user four times an hour.

Concept: cron jobs must be **idempotent** or **flag-guarded**, because they run repeatedly over the same data.

`StalePendingCron` exists because `/order` creates a `pending` session *before* payment. If the user abandons checkout, that row would hold the mentor's slot forever. Be able to explain this — it shows you think about failure paths, not just happy paths.

---

## Module 10 — The AI advisor and matching engine

Read at your own pace; know the shape well enough to describe it.

### 10.1 `AtyantEngine.js` (1832 lines)
Key methods: `detectQueryDetails`, `findBestSemanticMatch`, `findBestMentor`, `findTopMentors`, `processQuestion`, `getClarity`, `getTopAnswerCards`, `transformToAnswerCard`, `recordFeedback`, `recordOutcome`.

The flow: a student asks a career question → the engine understands the query → finds semantically similar mentor experiences / answer cards using **vector similarity** → picks the best mentor or synthesises an answer. Feedback and 30/60/90-day outcomes are recorded and feed back into ranking.

Ranking signals stored on `User` (`User.js:590-601`): `feedbackScore`, `outcomeScore` (**Laplace-smoothed** success rate), `outcomeCount`, `helpfulCount`.

**Laplace smoothing is worth understanding:** a mentor with 1 success out of 1 shouldn't outrank one with 47 out of 50. Smoothing adds pseudo-counts — `(successes + α) / (total + 2α)` — pulling low-sample rates toward the mean. That's a strong detail to drop in an interview.

Caching: `lru-cache` is a dependency and `flushAllCaches()` exists — embeddings are expensive, so they're cached.

### 10.2 `MatchingEngine.js`
`computeMatchScore(user, job)` and `matchJobsForUser(user, jobs, {minScore})` — deterministic, rule-based scoring of a user's skills/roles against job descriptions. Contrast with the embedding-based semantic search in `AtyantEngine`.

Know when each is right: rule-based is explainable, cheap, and debuggable; embeddings handle synonyms and phrasing the rules miss. This codebase uses both, in the places each fits.

### 10.3 SSE streaming
`POST /api/ai/atyant-chat` streams progress checkpoints via Server-Sent Events (hence the compression exemption in Module 2.3). SSE is a one-way server→client stream over plain HTTP — simpler than WebSocket when you only need one direction. Know the difference and when to pick each.

---

## Module 11 — Job aggregation and auto-apply

### 11.1 Adapters
`services/adapters/GreenhouseAdapter.js`, `LeverAdapter.js` — fetch job listings from each ATS's public API and normalise them into one internal `Job` shape.

This is the **adapter pattern**: each provider has its own API shape; each adapter translates it to your canonical model. Adding a new ATS means adding one file, not touching the rest of the system. `config/atsCompanies.js` lists which companies to sync.

### 11.2 Auto-apply
`services/autoapply/PlaywrightRunner.js` + `GreenhouseApplyAdapter.js`, `LeverApplyAdapter.js`.

**Playwright** drives a headless browser to fill and submit real application forms. `ApplicationAnswer` stores the user's reusable answers to common questions; `CoverLetterService` generates a tailored cover letter.

Guardrails on `User.autoApply` (`User.js:483-487`):
```js
enabled: false            // opt-in, off by default
minMatchScore: 70         // don't apply to poor matches
excludedCompanies: []     // user blocklist
consentedAt: null         // explicit recorded consent
```

Be ready to discuss this honestly: automated submissions on a user's behalf need **explicit consent, a quality threshold, an audit trail (`Application` model), and an off switch.** The schema has all four. Pointing that out unprompted reads very well.

---

## Module 12 — Cross-cutting concerns

### 12.1 CORS
`backend/server.js:104-149`. Browsers block cross-origin requests unless the server opts in via `Access-Control-Allow-Origin`.

Notable choices:
- Explicit allowlist, not `*` (line 104)
- `credentials: true` — required to send cookies cross-origin
- All localhost ports allowed in dev (line 124)
- Blocked origins are logged (line 131)
- `maxAge: 600` — caches the preflight for 10 minutes, cutting request count

**The preflight subtlety at line 144-149 is excellent interview material:** `app.options('*', cors(corsOptions))` must use the *same credentialed options*. A bare `cors()` there replies `Access-Control-Allow-Origin: *` with no `Allow-Credentials` header — and the browser rejects `*` for credentialed requests. It surfaced as "No 'Access-Control-Allow-Origin' header is present" on preflighted calls like `POST /api/livekit/join`.

Be able to explain **what a preflight is**: for non-simple requests (custom headers, `PUT`/`DELETE`, JSON content-type), the browser first sends an `OPTIONS` request asking permission, then sends the real one.

### 12.2 Helmet and CSP
`server.js:161-176`. Helmet sets defensive HTTP headers. The **Content Security Policy** whitelists where resources may load from:
```js
scriptSrc: ["'self'", 'https://checkout.razorpay.com'],
imgSrc:    ["'self'", 'data:', 'https://res.cloudinary.com'],
objectSrc: ["'none'"],
```
CSP is an **XSS mitigation**: even if an attacker injects a script tag, the browser refuses to load it from a non-whitelisted origin. `objectSrc: 'none'` kills Flash/plugin vectors.

Note `styleSrc` includes `'unsafe-inline'` — a real weakening, usually needed for CSS-in-JS. Know that it's a tradeoff, not an oversight.

### 12.3 Rate limiting
`middleware/globalRateLimiter.js`, `rateLimiters.js`, applied at `server.js:228` with community-chat excluded.

Purpose: prevent brute-force login, API abuse, and cost blowouts on the AI endpoints. Typical algorithms: fixed window, sliding window, token bucket. `express-rate-limit` defaults to memory storage — **which, like the Socket.IO maps, is per-process**. Multi-instance deployment needs a Redis store. Same caveat, same fix.

### 12.4 `trust proxy`
`server.js:82`: `app.set('trust proxy', 1)`.

Behind a reverse proxy (Nginx/Dokploy), every request's `req.ip` is the proxy's IP. Rate limiting would then throttle *all users as one*. `trust proxy` tells Express to read the real client IP from `X-Forwarded-For`. The `1` means trust exactly one hop — trusting blindly would let clients spoof the header.

Small line, real understanding. Interviewers like it.

### 12.5 Graceful shutdown
`server.js:706-718`. On `SIGTERM`/`SIGINT`:
1. `server.close()` — stop accepting new connections, let in-flight requests finish
2. Close the Mongo connection
3. Force-exit after 10s if something hangs

Without this, a redeploy kills in-flight requests mid-write and leaks database connections.

### 12.6 File uploads
`multer` handles multipart form data; files go to **Cloudinary** (`config/cloudinary.js`, `utils/cloudinaryUpload.js`), not local disk. Why: containers have ephemeral filesystems — a redeploy wipes local uploads. Cloudinary also gives you a CDN and transformations.

`pdf-parse` extracts resume text (used in `SessionPipelineService._fetchResumeText`, capped at 6000 chars so it doesn't blow the LLM token budget).

### 12.7 Email
Two paths: `Resend` (transactional API) and `nodemailer`. `utils/emailService.js` is 1636 lines — mostly HTML templates. Emails are consistently sent **without `await`** or with a `.catch()` that only logs, so a mail-provider outage never fails a payment or a booking.

That's a real principle: **non-critical side effects must not fail the critical path.**

---

## Module 13 — Deployment

- **Docker** (`backend/Dockerfile`, `docker/`) — the app and LiveKit run as containers on a VPS, orchestrated by Dokploy.
- **Node 20 enforced** via `engines` in `package.json` + the Dockerfile base image.
- **Shared volume** between the egress container and the backend for recordings (Module 7.7).
- **Env vars** for all config: `JWT_SECRET`, `MONGO_URI`, `RAZORPAY_*`, `GROQ_API_KEY(S)`, `LIVEKIT_*`, `RESEND_API_KEY`, `CLOUDINARY_*`, `RECORDINGS_PATH`, `FRONTEND_URL`.
- **Health check** — `GET /api/health` returns uptime, memory, and live socket count, for uptime monitoring.
- **DNS override** at `server.js:1-3` — `dns.setServers(['8.8.8.8','8.8.4.4'])`, forcing Google DNS because the VPS resolver was unreliable.

Never commit `.env`. Rotate any secret that has ever been committed.

---

## Module 14 — Interview preparation

### 14.1 Resume bullets (accurate, defensible)
Use these only if you can answer the follow-ups.

- Built and deployed a Node.js/Express + MongoDB backend (16 route modules, 17 data models) powering a career-mentorship platform with authentication, payments, real-time chat, video sessions, and AI-driven insights.
- Integrated Razorpay end-to-end — server-side price resolution, HMAC signature verification, idempotent confirmation, and a webhook fallback — plus a mentor payout ledger settled in monthly batches.
- Self-hosted a LiveKit WebRTC server with server-side audio recording; solved production race conditions with atomic conditional updates, active egress-health verification, and a reconnect grace period, recovering sessions that were previously lost to silent recording failures.
- Designed an async AI pipeline (Groq Whisper + Llama 3.3 70B) that transcribes and analyses session recordings, using map-reduce summarisation for long transcripts, ffmpeg chunking for large audio, key rotation with backoff, and a content heuristic that detects hallucinated transcripts instead of showing users fabricated summaries.
- Implemented real-time messaging with Socket.IO, including JWT handshake authentication and server-side identity enforcement to prevent cross-user room access.
- Built a job-aggregation pipeline with per-ATS adapters and a consent-gated Playwright auto-apply flow with match-score thresholds and an audit trail.

### 14.2 Three stories to have ready (problem → why it happened → what you did → result)

**1. 23% of pilot sessions had no recording.**
LiveKit accepted the egress job and returned an id, but under CPU pressure the worker never actually started and died ABORTED. We were treating "job accepted" as "recording running." Added active verification: poll the egress status after 20s (with one extra grace window for a slow worker), kill dead jobs, and start a fresh recording while the call is still live. Partial audio beats a lost session.

**2. An 88-minute session transcript was destroyed by an unrelated failure.**
Transcript and insights were saved together at the end, so when insight extraction failed the transcript was thrown away. Reordered to persist the transcript immediately after transcription, and added a recovery path that rebuilds insights from the stored transcript even after the audio file has been reaped. `/reprocess` became actually useful.

**3. Users were shown AI summaries of conversations that never happened.**
Whisper hallucinates filler over silence, so a dead-mic session still produced text, and the LLM dutifully summarised it. First fix — a unique-word ratio — false-positived on a real 88-minute session with heavy filler. Replaced it with: strip known filler words, then measure the *remaining* real content. Real conversations survive that; dead mics don't. And when it triggers we now save an honest explanatory insight rather than hiding the session.

Each of these has the shape interviewers want: a real failure, a wrong first attempt, a reasoned fix, a stated tradeoff.

### 14.3 Questions you will be asked — know the answer

1. Why MongoDB over PostgreSQL? *(Flexible evolving schemas, document-shaped data like insights/transcripts, fast iteration. Honest tradeoff: no real transactions across collections in the way SQL gives you, and payment data would arguably be safer relational.)*
2. How does JWT auth work and how do you revoke a token? *(Module 4.2. Answer: you largely can't — short expiry + refresh, or a revocation list that reintroduces state.)*
3. Why do webhooks need the raw body? *(Module 2.4.)*
4. How do you prevent double-charging a user? *(Idempotency check + signature verification + independent capture confirmation. Module 6.1.)*
5. What breaks if you run two instances of this server? *(Socket.IO maps and rate-limit store are per-process. Fix: Redis adapter + Redis rate-limit store. Module 5.5.)*
6. How do you handle a race between concurrent triggers of a one-time action? *(Atomic conditional update — the filter is the lock. Module 7.3.)*
7. How do you handle LLM outputs that don't match your schema? *(Coerce at the boundary; treat as untrusted input. Module 8.8.)*
8. Why is the pipeline serialised instead of parallel? *(Rate-limit protection; latency traded for reliability. Module 8.2.)*
9. What would you improve? *(Have three ready — see below. Never say "nothing.")*

### 14.4 What you'd improve — say these confidently
- **Tests.** There's no automated test suite. The payment verification and egress-claim logic are the highest-value places to start.
- **Redis** for Socket.IO presence and rate limiting, to allow horizontal scaling.
- **Move `errorHandler` to be the last `app.use`** — routes registered after it currently bypass it (`server.js:285`).
- **Make `optionalAuth` read cookies** like `auth` does, so cookie-authenticated users aren't treated as guests.
- **Structured logging + error tracking** (Sentry) instead of `console.log` with emoji.
- **Zod validation at every route boundary** — the dependency is already there but isn't applied consistently.

Naming concrete, specific weaknesses in your own code is one of the strongest signals you can give.

---

## Module 15 — Study plan

**Day 1 — Foundations.** Modules 1–3. Read `server.js` top to bottom. Read `models/Session.js` fully. Draw the middleware pipeline from memory.

**Day 2 — Auth & real-time.** Modules 4–5. Read `middleware/auth.js` and the Socket.IO block. Trace one message end to end.

**Day 3 — Payments.** Module 6. Read `routes/paymentRoutes.js` fully. Draw the order → verify → webhook sequence, marking every validation step.

**Day 4 — Video & recording.** Module 7. Read `routes/livekitRoutes.js` fully. Explain `ensureEgress` line by line out loud.

**Day 5 — AI pipeline.** Module 8. Read `SessionPipelineService.js` fully. Trace a 75-minute session through every branch.

**Day 6 — Everything else.** Modules 9–13.

**Day 7 — Interview prep.** Module 14. Say every story out loud, timed, without notes.

### The real test
Run the server locally, open `GET /api/health`, then pick any endpoint and trace it from the HTTP request through every middleware, the route handler, the database call, and the response — without reading this guide.

If you can do that for `POST /api/payments/verify` and `POST /api/livekit/webhook`, you know this backend.

### One rule
AI wrote a lot of this code. That's fine and increasingly normal — but in an interview you own it. Only claim what you can explain. "I used AI to accelerate the implementation, and here's the failure it didn't catch and how I diagnosed it" is a far stronger answer than pretending otherwise, and this codebase gives you three real ones (Module 14.2).
