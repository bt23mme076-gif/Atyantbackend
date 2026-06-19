# Atyant — Full System Report

*How everything works, end to end. Generated from the live codebase (`Atyantbackend` + `Atyantfrontend`).*

---

## 1. What Atyant is

Atyant is a **placement & career-clarity platform** that connects students with **verified senior mentors who walked their exact path** (same college, branch, target company). The core promise: *"Find someone exactly like you."*

Three things make it work:
1. **AI matching engine** — pairs a student's confusion to the right mentor using vector search + a weighted scoring model.
2. **Answer cards** — mentors' real experiences, turned into searchable "instant answers" so students get value even before booking.
3. **Paid 1:1 sessions** — text/audio/video/resume-review, run on Atyant's own in-house meet (LiveKit), recorded and auto-summarized into the student's dashboard.

---

## 2. Architecture & infrastructure

```
┌─────────────────────┐     ┌──────────────────────────┐     ┌────────────────────┐
│  atyant.in          │     │  atyantproduct.vercel.app│     │ api.product.atyant.in│
│  (MARKETING site)   │     │  (REACT PRODUCT APP)     │     │  (EXPRESS BACKEND)  │
│  Vercel project     │────▶│  Vercel project          │────▶│  Node/Express on VPS│
│  "atyant"           │ rew │  repo: Atyantfrontend    │ API │  via Dokploy/Traefik │
│  proxies / +        │ rite│  Vite + React 19         │     │  187.127.133.111    │
│  /product-assets/*  │     │                          │     └─────────┬──────────┘
└─────────────────────┘     └──────────────────────────┘               │
                                                                        ▼
                          ┌──────────────────────┐   ┌──────────────────────────────┐
                          │  MongoDB Atlas        │   │ meet.api.product.atyant.in   │
                          │  (Mongoose, vector    │   │ LiveKit v1.13.1 (self-hosted │
                          │   search index)       │   │ on same VPS, Dokploy/Traefik)│
                          └──────────────────────┘   └──────────────────────────────┘
```

**Frontend** — Vite + React 19 SPA. Deployed as the Vercel project that serves `atyantproduct.vercel.app`. The marketing site at `atyant.in` is a **separate Vercel project** that rewrites `/` and `/product-assets/*` to the product app. (This is why the meet is served at `atyant.in/?meet=<id>` — only `/` is proxied; a real path like `/session/meet/<id>` falls through to marketing.)

**Backend** — Node/Express, deployed on a **Hostinger KVM VPS** (`187.127.133.111`) managed by **Dokploy**, fronted by **Traefik** (TLS via Let's Encrypt). Serves only `/api/*` and `/auth/*` — no frontend.

**Database** — MongoDB (Atlas), via Mongoose. Uses **Atlas Vector Search** (`vector_index`) for semantic matching of questions → answer cards.

**Realtime meet** — self-hosted **LiveKit v1.13.1** on the same VPS, reachable at `meet.api.product.atyant.in` (WebSocket `wss://`). Includes built-in TURN (UDP 3478) and an **Egress** worker for audio recording.

**AI** — **Groq** (OpenAI-compatible API) for both LLM (`llama-3.3-70b` / `qwen3-32b` depending on env) and **Whisper** (`whisper-large-v3`) transcription.

**Other integrations** — Razorpay (payments), Resend (email), Cloudinary (image uploads), Google OAuth + (optional) Google Calendar.

---

## 3. Data model (MongoDB collections)

| Model | Purpose |
|---|---|
| **User** | Students, mentors, admins (single collection, `role` field). Holds profile, education, mentor matching fields (topCompanies, specialTags, expertise, primaryDomain), availability, services offered, stats (rating, feedback, outcomes), credits, subscription. |
| **AnswerCard** | A mentor's structured experience answer (situation, what worked, mistakes, timeline) + **vector embedding** + follow-ups + feedback. The unit that powers "instant answers". |
| **MentorExperience** | Raw mentor experience submissions (pre-refinement). |
| **Question** | Student questions in the Q&A/clarity system. |
| **Session** | A booked 1:1 (mentor, student, service, schedule, payment, LiveKit room, egress id, pipeline status, **payout ledger**). |
| **SessionTranscript** | Whisper transcript of a recorded session. |
| **SessionInsight** | LLM-extracted insights from a session (summary, action items, pain points, mentor quality score). |
| **Booking** | Legacy/auxiliary booking record. |
| **Roadmap** | Student's personalized step-by-step career roadmap. |
| **SavedAnswer** | Bookmarked answers / session summaries shown in "Saved Answers". |
| **AIConversation / AtyantConversation / Message** | "Ask Atyant" chat history + mentor↔student chat. |
| **MatchLog** | Diagnostic log of every match (for tuning the engine). |

---

## 4. Core user flows

### 4.1 Authentication (`routes/auth.js`)
- **Email/password** signup + login → returns a **JWT** stored in `localStorage` as `atyant_token`.
- **Google OAuth** (`/api/auth/google` → callback) → redirects back to frontend with `?token=`.
- **Forgot password** → OTP-based: `forgot-password` → `verify-reset-code` → `reset-password`.
- Token is sent as `Authorization: Bearer <token>` on every API call. `protect` middleware = strict (rejects with 401); `optionalAuth` = lenient (works for guests, e.g. the public clarity match).
- ⚠️ Because the token lives in `localStorage`, it is **per-origin** — the app and the meet must run on the **same origin** (`atyant.in`) for auth to carry over.

### 4.2 "Ask Atyant" — AI chat (`routes/aiRoutes.js`, `services/AIService.js`)
- Free conversational AI (Groq LLM). Answers career questions, can suggest relevant mentors (`findRelevantMentors`).
- Conversation history persisted (`AIConversation`). Credits/subscription gate heavier use.

### 4.3 Clarity / matching — **the core IP** (`routes/clarityRoutes.js` → `services/AtyantEngine.js`)
This is the "Find someone exactly like you" flow. Public (no login needed).

1. Student types their confusion + (optionally) college/branch/year/goal.
2. `generateProblemStatement` turns the chat context into a structured brief.
3. `AtyantEngine.getClarity()` runs **two paths in parallel**:
   - **Answer-card path** — embeds the question (Groq), runs **Atlas Vector Search** against `AnswerCard.embedding`, returns the best instant answer + a scrollable feed of top seniors' cards (`getTopAnswerCards`).
   - **Mentor path** — `findTopMentors` scores live mentors with a weighted model and returns the top N.
4. Mentors are enriched with display fields + a human "why matched" reason (same college / same branch / cracked X company).
5. Result cached 5 min by `query|college|branch`.

**The scoring model** (`CONFIG.WEIGHTS` / `LIVE_WEIGHTS`): combines exact company match, same college (alias-aware), same branch, college tier, expertise, special tags, **verified outcomes** (the moat metric — did the mentor's advice actually work?), feedback score, rating, recent activity, and a **goal-signal boost** (an "IIM" goal decisively favors a mentor who actually did IIM over an IIT look-alike). Load penalty spreads demand across mentors; cold-start boost gives new mentors visibility.

### 4.4 Answer cards (`routes/mentorRoutes.js`)
- Mentor submits a raw experience → `AIService.refineExperience` (Groq) structures it into situation / what worked / mistakes / timeline / different approach.
- An **embedding** is generated and stored on the `AnswerCard` → it becomes searchable by the vector path above.
- Students can ask up to 2 follow-ups per card.

### 4.5 Mentor onboarding (`pages/MentorOnboard.jsx` + `routes/mentorRoutes.js` `/onboard`)
- Mentor uploads their **LinkedIn profile as PDF** → `profileAPI.parseLinkedin` parses it and **auto-fills** name, college, branch, year, companies, skills, tags, bio.
- 3-step wizard: Account → Profile (LinkedIn import + basics) → Mentoring (domain, tags, story).
- On finish, a flag (`atyant_open_answercard`) makes the Profile page **open the answer-card section** so the mentor immediately creates their first card.
- A completeness gate sets `mentorListed: true` → mentor enters the live matching pool.
- Existing mentors can re-import LinkedIn from the Profile page to refresh (fills empty fields only, never overwrites edits).

### 4.6 Booking + payment (`routes/paymentRoutes.js`, `components/BookingModal.jsx`)
- Services are **platform-fixed** (`config/serviceCatalog.js`): Text Q&A ₹49, Audio Call ₹99, Video Call ₹299, Resume Review ₹199. Mentors only pick **which** they offer (`User.servicesOffered`); availability is a weekly recurring schedule.
- Booking modal: pick service → pick slot (from mentor availability) → confirm.
- **Free** mentors confirm instantly; **paid** create a **Razorpay order**, verified server-side via HMAC signature.
- On confirm, `finalizeSession`:
  - Creates the LiveKit room (idempotent),
  - Sets `session.meetingLink` (`/?meet=<id>` form),
  - Emails both parties (Resend).
- **Money flow**: all payments land in the **company Razorpay account**. Each session records `mentorShare`, `platformFeePct`, and a **payout ledger** (`payoutStatus`, `payoutBatchId`) so mentors can be paid in a monthly batch with a single query.

### 4.7 The in-house meet (`routes/livekitRoutes.js`, `services/LiveKitService.js`)
- Student/mentor opens `atyant.in/?meet=<sessionId>` → `MeetPage` calls `POST /api/livekit/join/:sessionId`.
- Backend verifies the user is a participant, **ensures the LiveKit room exists** (idempotent — rooms are GC'd after `emptyTimeout`), issues a **LiveKit access token** (mentor = admin), and **starts audio Egress** on first join.
- Frontend connects via `@livekit/components-react` with `iceTransportPolicy: 'relay'` (forces TURN to survive Indian-ISP UDP NAT timeouts) and a smart `onDisconnected` (only navigates away on a real user leave, not on transient network drops).
- **Webhooks** (`/api/livekit/webhook`, signature-verified):
  - `room_finished` → marks the session completed.
  - `egress_ended` → kicks off the **session pipeline** with the recording.

### 4.8 Session pipeline (`services/SessionPipelineService.js`)
After a recorded session ends:
1. **Transcribe** the audio with Groq **Whisper**.
2. **Extract insights** with Groq LLM → JSON: topics, student pain points, action items (student + mentor), mentor quality score, sentiment, summary, career context.
3. Persist `SessionTranscript` + `SessionInsight`, mark `pipelineStatus: completed`.
4. **`_saveToUserDashboard`** — writes the session **summary** and **action items** into the student's **Saved Answers**, and pushes a new phase into their **My Roadmap**.
5. Cleans up the audio file.

### 4.9 Roadmap & Saved Answers
- **My Roadmap** (`routes/roadmapRoutes.js`) — AI-drafted, phase-based career plan personalized from the student's branch/goals/CGPA; refined by mentor sessions (pipeline pushes steps); student ticks off tasks.
- **Saved Answers** (`routes/savedAnswerRoutes.js`) — bookmarked insights + auto-saved session summaries/action items.

### 4.10 Subscriptions (`routes/subscriptionRoutes.js`)
- Plans: **free**, **clarity** (₹299/mo or ₹2390/yr, 1 credit/mo), **pro** (₹699/mo or ₹5590/yr, 3 credits/mo). Razorpay-backed, HMAC-verified.

### 4.11 Reminders (`services/ReminderCron.js`)
- Cron job emails session reminders (24h + 1h before), with flags on the session to prevent duplicate sends.

---

## 5. Deployment topology (important operational facts)

| Component | Where | Domain |
|---|---|---|
| Marketing site | Vercel project "atyant" | `atyant.in`, `www.atyant.in`, `atyant.vercel.app` |
| Product app (React) | Vercel project "atyantproduct" | `atyantproduct.vercel.app` (proxied at `atyant.in/`) |
| Backend (Express) | VPS via Dokploy/Traefik | `api.product.atyant.in` |
| LiveKit + Egress + Redis | VPS via Dokploy/Traefik | `meet.api.product.atyant.in` (WS), TURN UDP 3478 |

**Key env vars (backend):**
- `LIVEKIT_HOST` / `LIVEKIT_WS_URL` → must be `https://meet.api.product.atyant.in` / `wss://...` (the Traefik-routed domain; `meet.atyant.in` is **not** configured and returns Traefik's 404).
- `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`, `GROQ_API_KEY`, `RAZORPAY_*`, `FRONTEND_URL`, Mongo URI, Resend, Cloudinary, Google OAuth.

**Frontend env:** `VITE_API_URL=https://api.product.atyant.in` (must have **no trailing slash** — a trailing slash produced `//api` double-slash requests).

---

## 6. Request lifecycle examples

**Student gets clarity (logged out):**
`atyant.in` → React → `POST api.product.atyant.in/api/clarity/match` → AtyantEngine (vector search + mentor scoring) → answer cards + ranked mentors → rendered.

**Student joins a paid session:**
`atyant.in/?meet=<id>` → React MeetPage (same origin → token available) → `POST /api/livekit/join/<id>` → backend verifies participant, creates room, mints LiveKit token, starts egress → React connects to `wss://meet.api.product.atyant.in` via TURN relay → after the call, `egress_ended` webhook → Whisper + Groq → summary & action items land in the student's dashboard.

---

## 7. Known issues / tech debt
- **Auth is `localStorage`-bound** → meet must be same-origin as login (handled via `/?meet=` on `atyant.in`).
- `VITE_API_URL` had a **trailing slash** in Vercel → `//api` (now stripped defensively in code, but fix the env var too).
- A **service worker** (workbox) can serve stale cached assets on `atyant.in` — clear it after deploys if behavior looks old.
- LiveKit **TURN over TLS (5349)** is not fully wired (no Traefik TCP entrypoint); UDP TURN (3478) carries relay.
- Backend `frontendUrl.js` change (meet links as `/?meet=`) is committed locally but only affects **emailed** links once the backend is redeployed.

---

*Report reflects the codebase as of this session. Two repos: `C:\Atyantbackend` (Express API) and `C:\Atyantfrontend` (React app).*
