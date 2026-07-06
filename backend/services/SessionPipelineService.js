import fs from 'fs';
import axios from 'axios';
import FormData from 'form-data';
import Session from '../models/Session.js';
import SessionTranscript from '../models/SessionTranscript.js';
import SessionInsight from '../models/SessionInsight.js';
import SavedAnswer from '../models/SavedAnswer.js';
import Roadmap from '../models/Roadmap.js';
import { groqJSON, groqRotate, GROQ_API_KEYS } from '../utils/groqClient.js';

const WHISPER_MODEL   = process.env.GROQ_WHISPER_MODEL  || 'whisper-large-v3';
// In-depth analysis needs a capable model — the 8b "instant" model produced thin,
// generic 2-line summaries and empty rich fields (which is why saved-answer
// summaries and roadmaps came out short). 70b-versatile gives a genuinely useful
// breakdown. Override with GROQ_PIPELINE_MODEL if needed.
const PIPELINE_MODEL  = process.env.GROQ_PIPELINE_MODEL || 'llama-3.3-70b-versatile';

// ── Long-session (up to ~1.5–2 h) handling ──
// A single insight request is capped at SINGLE_LIMIT chars (~6k input tokens),
// which stays under Groq's free-tier tokens-per-minute budget. Longer
// transcripts are map-reduced: per-chunk condensed notes → one merge call.
// Chunks are spaced CHUNK_SPACING_MS apart so a 90-min session never 429s.
const SINGLE_LIMIT     = 24000;
const CHUNK_SIZE       = 20000;
const MAX_CHUNKS       = 8;        // ~160k chars ≈ 2.5+ h of speech; beyond that we truncate
const CHUNK_SPACING_MS = 15000;
// Groq free-tier rejects audio files over 25 MB. At our 24 kbps voice encoding
// that's >2 h of audio, so real sessions never hit it — but fail with a clear
// message instead of a cryptic 413 if one ever does.
const MAX_AUDIO_BYTES  = 24 * 1024 * 1024;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class SessionPipelineService {

  // Entry point — called after egress_ended webhook (and /reprocess).
  // Sessions are processed ONE AT A TIME through an in-process queue: pilot
  // batches end many sessions within minutes, and N parallel pipelines would
  // stampede Groq's per-minute budget and 429 each other into 'failed'.
  async processSession(sessionId, audioPath) {
    this._queue = (this._queue ?? Promise.resolve())
      .then(() => this._process(sessionId, audioPath));
    return this._queue; // _process never throws — safe to chain
  }

  async _process(sessionId, audioPath) {
    await Session.findByIdAndUpdate(sessionId, { pipelineStatus: 'processing', pipelineError: null });
    try {
      let transcript;
      try {
        this._validateAudioFile(audioPath);
        transcript = await this._withRetry(() => this._transcribe(audioPath), 'transcription');

        // Persist the transcript IMMEDIATELY — before insight extraction. The old
        // order saved both together at the end, so an insight failure threw away a
        // perfectly good transcript (July 6: an 88-min recording transcript lost).
        await SessionTranscript.findOneAndUpdate(
          { sessionId },
          {
            sessionId,
            rawText: transcript.text,
            segments: transcript.segments || [],
            language: transcript.language || 'en',
            duration: transcript.duration,
          },
          { upsert: true, new: true }
        );
      } catch (err) {
        // Audio gone or unusable (retention window passed, volume issue) — if a
        // transcript from an earlier run survives in Mongo, rebuild insights
        // from it instead of failing. This is what makes /reprocess useful
        // AFTER the .ogg has been reaped.
        const stored = await SessionTranscript.findOne({ sessionId }).lean();
        if (!stored?.rawText) throw err;
        console.warn(`Audio unavailable for session ${sessionId} (${err.message}) — rebuilding insights from the stored transcript`);
        transcript = {
          text: stored.rawText,
          segments: stored.segments || [],
          language: stored.language,
          duration: stored.duration,
        };
      }

      // Whisper hallucinates filler ("Thank you… you you you") over silence, and
      // the insight prompt is required to produce a summary — so a dead-mic
      // session used to get a FABRICATED summary on the student's dashboard.
      // Flag it honestly instead and skip insights entirely.
      if (this._isLowContent(transcript)) {
        await Session.findByIdAndUpdate(sessionId, {
          pipelineStatus: 'no_audio',
          pipelineError: `Recording contains almost no real speech (${(transcript.text || '').trim().length} chars) — likely a mic/connection failure during the call.`,
        });
        console.warn(`⚠️ Session ${sessionId}: transcript is near-empty — marked no_audio, insights skipped.`);
        return;
      }

      const sessionDoc = await Session.findById(sessionId).lean();
      const insights = this._normalizeInsights(await this._extractInsightsSmart(transcript.text, sessionDoc));

      // groqJSON returns {} on JSON-parse failure — treat a fully empty result
      // as an error (retryable via /reprocess) rather than storing a blank
      // insight that would render as an empty dashboard card.
      if (!insights.summary && !insights.detailedSummary && !insights.keyDiscussionPoints.length) {
        throw new Error('Insight extraction returned empty JSON');
      }

      await SessionInsight.findOneAndUpdate(
        { sessionId },
        { sessionId, ...insights },
        { upsert: true, new: true }
      );
      await Session.findByIdAndUpdate(sessionId, { pipelineStatus: 'completed', pipelineError: null });
      await this._saveToUserDashboard(sessionDoc, insights);

      console.log(`✅ Pipeline completed for session ${sessionId}`);
    } catch (err) {
      console.error(`❌ Pipeline failed for session ${sessionId}:`, err.message);
      await Session.findByIdAndUpdate(sessionId, {
        pipelineStatus: 'failed',
        pipelineError: String(err.message || err).slice(0, 500),
      }).catch(() => { /* keep webhook alive even if this write fails */ });
    }
    // Source recording is never deleted here (success or failure) — the app no
    // longer touches the .ogg. Raw recordings live under /tmp/recordings and are
    // reaped by the VPS cron after 48 h (docker/livekit/setup-vps.sh), so audio
    // survives long enough to retry while the derived transcript/insights
    // persist permanently in MongoDB. Deleting on failure was the bug that made
    // a completed 57-min recording unrecoverable the one time transcription
    // errored. To retry a failed run, POST /api/sessions/:id/reprocess (admin
    // only) — it uses the .ogg if present, else rebuilds from the stored
    // transcript.
  }

  // Fail fast with a DB-visible reason instead of a cryptic Groq 4xx.
  _validateAudioFile(audioPath) {
    if (!fs.existsSync(audioPath)) {
      throw new Error(`Audio file not found: ${audioPath} — check the egress↔backend shared volume / retention cron`);
    }
    const { size } = fs.statSync(audioPath);
    if (size === 0) throw new Error('Recording file is empty (0 bytes) — egress aborted before capturing audio');
    if (size > MAX_AUDIO_BYTES) {
      throw new Error(`Recording is ${(size / 1048576).toFixed(1)} MB — over the ${MAX_AUDIO_BYTES / 1048576} MB transcription cap`);
    }
  }

  // Detects silence-hallucination transcripts. Whisper pads silence/pauses with
  // "you / thank you / hello" loops, so a unique-to-total word RATIO is fooled: a
  // rich 88-min session with heavy interspersed filler scores a low ratio and
  // gets wrongly rejected (this exact false-positive hid shyamak's real 34k-char
  // college-guidance session — its audio was fine). Instead we STRIP the filler
  // and measure how much REAL content is left: a genuine conversation keeps
  // thousands of chars and hundreds of distinct words even when heavily padded;
  // a dead-mic recording has almost nothing once the filler is removed.
  _isLowContent(transcript) {
    const text = (transcript.text || '').replace(/\s+/g, ' ').trim();
    if (text.length < 300) return true;
    if ((transcript.duration || Infinity) < 60) return true; // <1 min of audio is not a session

    const cleaned = text
      .replace(/\b(you|thanks?|thank you|hello+|hi|hey|yeah|yep|okay|ok|um+|uh+|hmm+|mm+|bye)\b[.,]?/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const realWords  = cleaned.split(' ').filter(w => w.length > 1);
    const uniqueReal = new Set(realWords.map(w => w.toLowerCase())).size;
    // Real session: lots of distinct meaningful words survive. Dead-mic: a handful.
    return cleaned.length < 500 || uniqueReal < 50;
  }

  // Retry transient failures (429 rate limits, 5xx, timeouts) with a wait long
  // enough for Groq's per-minute buckets to refill. Non-retryable errors (bad
  // file, bad key) surface immediately.
  async _withRetry(fn, label, attempts = 2) {
    for (let i = 0; ; i++) {
      try { return await fn(); }
      catch (err) {
        const status = err.status || err.response?.status;
        const retryable = status === 429 || status >= 500
          || /timeout|timed out|aborted|network|fetch failed|socket/i.test(String(err.message));
        if (i >= attempts || !retryable) throw err;
        const wait = 60000 * (i + 1);
        console.warn(`Pipeline ${label} attempt ${i + 1} failed (${err.message}) — retrying in ${wait / 1000}s`);
        await sleep(wait);
      }
    }
  }

  async _transcribe(audioPath) {
    if (!GROQ_API_KEYS.length) throw new Error('GROQ_API_KEY not configured');
    if (!fs.existsSync(audioPath)) throw new Error(`Audio file not found: ${audioPath}`);

    // Rotate keys / fail over on rate limits. A fresh FormData stream is built per
    // attempt because a read stream can only be consumed once.
    const response = await groqRotate(async (apiKey) => {
      const form = new FormData();
      form.append('file', fs.createReadStream(audioPath), {
        filename: 'audio.ogg',
        contentType: 'audio/ogg',
      });
      form.append('model', WHISPER_MODEL);
      form.append('response_format', 'verbose_json');
      form.append('language', 'en');

      return axios.post(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        form,
        {
          headers: {
            ...form.getHeaders(),
            Authorization: `Bearer ${apiKey}`,
          },
          maxBodyLength: Infinity,
          // Axios has NO default timeout — a hung upload would stall the whole
          // pipeline queue forever. 8 min is generous for a ~20 MB file.
          timeout: 480000,
        }
      );
    });

    return {
      text: response.data.text || '',
      segments: (response.data.segments || []).map(s => ({
        text: s.text,
        start: s.start,
        end: s.end,
      })),
      language: response.data.language,
      duration: response.data.duration,
    };
  }

  // Router: short transcripts go through the proven single-call path; long ones
  // (a 90-min session is ~50–60k chars) are map-reduced so the END of the
  // session — where action items and next steps actually live — is analyzed
  // instead of sliced off. The old `.slice(0, 24000)` silently dropped
  // everything past ~40 min.
  async _extractInsightsSmart(transcriptText, sessionDoc) {
    if (transcriptText.length <= SINGLE_LIMIT) {
      return this._withRetry(() => this._extractInsights(transcriptText, sessionDoc), 'insight extraction');
    }

    const chunks = [];
    for (let i = 0; i < transcriptText.length && chunks.length < MAX_CHUNKS; i += CHUNK_SIZE) {
      chunks.push(transcriptText.slice(i, i + CHUNK_SIZE));
    }
    console.log(`📝 Long transcript (${transcriptText.length} chars) → ${chunks.length}-chunk map-reduce`);

    const notes = [];
    for (let i = 0; i < chunks.length; i++) {
      const part = await this._withRetry(
        () => groqJSON(
          [
            {
              role: 'system',
              content: `You are an expert career-mentorship analyst taking condensed notes on PART ${i + 1} of ${chunks.length} of a mentor–student session transcript. Note ONLY what is actually said — never invent. Return ONLY valid JSON.`,
            },
            {
              role: 'user',
              content: `Topic: ${sessionDoc?.topic || 'Career Guidance'}

Return ONLY this JSON (empty arrays for anything not present in THIS part):
{
  "partSummary": "3-5 sentence summary of this part",
  "keyPoints": ["important things said/decided"],
  "studentPainPoints": ["concerns the student raised"],
  "mentorAdvice": ["guidance the mentor gave"],
  "actionItems": ["next steps agreed"],
  "resources": ["books/courses/tools/people suggested"],
  "studentStrengths": ["things the student is doing well"],
  "studentGaps": ["weaknesses/gaps surfaced"]
}

Transcript part ${i + 1}/${chunks.length}:
${chunks[i]}`,
            },
          ],
          { model: PIPELINE_MODEL, maxTokens: 1000, timeoutMs: 90000 }
        ),
        `insight chunk ${i + 1}/${chunks.length}`
      );
      notes.push(part);
      if (i < chunks.length - 1) await sleep(CHUNK_SPACING_MS); // stay under free-tier TPM
    }

    // Reduce: merge the sequential notes into the final full-schema insight.
    return this._withRetry(
      () => this._extractInsights(
        `[These are condensed sequential notes from ${chunks.length} parts of one long session — merge them into a single coherent analysis.]\n\n${JSON.stringify(notes)}`,
        sessionDoc
      ),
      'insight merge'
    );
  }

  async _extractInsights(transcriptText, sessionDoc) {
    if (!GROQ_API_KEYS.length) throw new Error('GROQ_API_KEY not configured');

    // Shared rotating client in JSON mode → valid JSON back, key failover for free.
    return groqJSON(
      [
        {
          role: 'system',
          content: 'You are an expert career-mentorship analyst. You read a transcript of a 1:1 mentor–student session and produce a thorough, specific, useful breakdown for the student to act on. Be concrete and grounded ONLY in what was actually said — never invent advice that was not given. Always fill every field: use [] or "" ONLY when something was genuinely not discussed, but NEVER leave summary/detailedSummary empty. Return ONLY valid JSON, no markdown, no extra text.',
        },
        {
          role: 'user',
          content: `Analyze this mentor–student career guidance session transcript in depth.
Topic: ${sessionDoc?.topic || 'Career Guidance'}

Return ONLY this JSON structure (fill EVERY field from the transcript):
{
  "summary": "2-3 sentence recap of the session",
  "detailedSummary": "A rich 5-8 sentence narrative: what the student came in with, what was actually discussed, the mentor's main guidance, concrete examples/numbers used, and how it concluded. Be specific to THIS conversation — no generic filler.",
  "topics": ["specific topics discussed"],
  "keyDiscussionPoints": ["the most important things actually said/decided, each a full sentence"],
  "studentPainPoints": [{ "point": "a real concern the student raised", "timestamp": "mm:ss if known else ''" }],
  "strengths": ["things the student is already doing well, per the conversation"],
  "areasToImprove": ["concrete gaps/weaknesses surfaced in the session"],
  "actionItems": { "student": ["specific, doable next steps for the student"], "mentor": ["follow-ups the mentor committed to"] },
  "recommendedResources": ["books, courses, tools, people, or links the mentor suggested"],
  "nextSessionFocus": ["what the next session should cover"],
  "mentorQualityScore": 7,
  "mentorQualityReason": "1-2 sentences justifying the score from the transcript",
  "studentSentiment": "positive",
  "careerContext": "placement"
}

Valid values — studentSentiment: positive|neutral|negative
Valid values — careerContext: placement|higher_studies|skill_gap|other

Transcript:
${transcriptText.slice(0, SINGLE_LIMIT)}`,
        },
      ],
      // SINGLE_LIMIT chars (~6k input tokens) + ~2.5k output keeps one request
      // under Groq's free-tier 12k tokens-per-minute cap. Transcripts longer
      // than SINGLE_LIMIT never reach this slice — _extractInsightsSmart
      // map-reduces them first so nothing is dropped. If a run does fail, the
      // recording is retained and can be re-run via /api/sessions/:id/reprocess.
      { model: PIPELINE_MODEL, maxTokens: 2560, timeoutMs: 120000 },
    );
  }

  // The LLM's JSON shape varies — an array field sometimes comes back as a bare
  // string (or is missing). Coerce every field to the type the schema and the
  // dashboard code (.map/.slice) expect, so a formatting quirk can never crash
  // the pipeline. Grounds the "1-hour session works without error" guarantee.
  _normalizeInsights(insights = {}) {
    const arr = (v) => Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
    const strArr = (v) => arr(v).map(x => (typeof x === 'string' ? x : String(x?.point ?? x ?? ''))).filter(Boolean);

    const ai = insights.actionItems;
    const actionItems = (ai && typeof ai === 'object' && !Array.isArray(ai))
      ? { student: strArr(ai.student), mentor: strArr(ai.mentor) }
      : { student: strArr(ai), mentor: [] };

    return {
      ...insights,
      summary:              typeof insights.summary === 'string' ? insights.summary : (insights.summary ? String(insights.summary) : ''),
      detailedSummary:      typeof insights.detailedSummary === 'string' ? insights.detailedSummary : (insights.detailedSummary ? String(insights.detailedSummary) : ''),
      topics:               strArr(insights.topics),
      keyDiscussionPoints:  strArr(insights.keyDiscussionPoints),
      strengths:            strArr(insights.strengths),
      areasToImprove:       strArr(insights.areasToImprove),
      recommendedResources: strArr(insights.recommendedResources),
      nextSessionFocus:     strArr(insights.nextSessionFocus),
      studentPainPoints:    arr(insights.studentPainPoints).map(p =>
                              typeof p === 'string' ? { point: p, timestamp: '' } : { point: String(p?.point ?? ''), timestamp: String(p?.timestamp ?? '') }
                            ).filter(p => p.point),
      actionItems,
    };
  }

  async _saveToUserDashboard(sessionDoc, insights) {
    const studentId = sessionDoc.userId;
    const mentorId  = sessionDoc.mentorId;
    const sessionId = sessionDoc._id;
    const topic     = sessionDoc.topic || 'Career Guidance';
    const mentorName = sessionDoc.mentorName || 'Your Mentor';

    // A /reprocess run must REPLACE its own earlier dashboard writes, not stack
    // duplicates on top of them. New cards are tagged with sessionId (below) so
    // this delete only ever touches this session's auto-saved cards.
    try {
      await SavedAnswer.deleteMany({ sessionId });
    } catch (err) {
      console.warn('Dashboard dedupe warning (non-fatal):', err.message);
    }

    const ops = [];

    // Session summary → SavedAnswer (shown in "Saved Answers"). Prefer the rich
    // in-depth narrative so the card is substantive, not a one-liner; append the
    // key discussion points so the student gets the full picture.
    const keyPoints = (insights.keyDiscussionPoints || []).slice(0, 5);
    const summaryBody = insights.detailedSummary || insights.summary || '';
    const savedSummary = summaryBody + (keyPoints.length
      ? `\n\nKey points discussed:\n${keyPoints.map(p => `• ${p}`).join('\n')}`
      : '');
    if (savedSummary.trim()) {
      ops.push(
        SavedAnswer.create({
          userId:     studentId,
          question:   savedSummary.trim(),
          tags:       [...(insights.topics?.slice(0, 3) || []), 'Session Summary'],
          sourceType: 'mentor',
          mentorId,
          sessionId,
        })
      );
    }

    // Each student action item → individual SavedAnswer
    const actionItems = insights.actionItems?.student || [];
    for (const item of actionItems.slice(0, 5)) {
      ops.push(
        SavedAnswer.create({
          userId:     studentId,
          question:   item,
          tags:       [topic, 'Action Item'].filter(Boolean),
          sourceType: 'mentor',
          mentorId,
          sessionId,
        })
      );
    }

    // Session → new phase(s) in the student's roadmap. Build substantive tasks
    // grounded in the session: agreed next steps, gaps to close, and what to
    // prep for the next session — not just a bare list of action items.
    const improve = (insights.areasToImprove || []).map(a => `Work on: ${a}`);
    const nextFocus = (insights.nextSessionFocus || []).map(n => `Prepare: ${n}`);
    const phaseTasks = [...actionItems, ...improve, ...nextFocus]
      .map(t => String(t).trim()).filter(Boolean).slice(0, 8);

    if (phaseTasks.length) {
      const sessionDate = new Date(sessionDoc.scheduledAt || Date.now())
        .toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

      const newStep = {
        phase:    `Session – ${sessionDate}`,
        title:    `${mentorName} — ${topic}`,
        duration: '2–4 weeks',
        status:   'active',
        tasks:    phaseTasks,
      };

      // upsert:true so students who never generated a goal-roadmap still get
      // their session roadmap (instead of the step silently going nowhere).
      // The $pull first removes this session's own step from a previous run
      // (same phase+title = same session/date), so /reprocess replaces instead
      // of appending a duplicate phase.
      ops.push(
        Roadmap.findOneAndUpdate(
          { userId: studentId },
          { $pull: { steps: { phase: newStep.phase, title: newStep.title } } }
        ).then(() =>
          Roadmap.findOneAndUpdate(
            { userId: studentId },
            { $push: { steps: newStep }, $setOnInsert: { userId: studentId, generatedAt: new Date() } },
            { upsert: true }
          )
        )
      );
    }

    try {
      await Promise.all(ops);
      console.log(`✅ Dashboard updated for student ${studentId} (${ops.length} items)`);
    } catch (err) {
      console.error('Dashboard save error (non-fatal):', err.message);
    }
  }
}

export default new SessionPipelineService();
