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

class SessionPipelineService {

  // Entry point — called after egress_ended webhook
  async processSession(sessionId, audioPath) {
    await Session.findByIdAndUpdate(sessionId, { pipelineStatus: 'processing' });
    try {
      const transcript = await this._transcribe(audioPath);
      const sessionDoc = await Session.findById(sessionId).lean();
      const insights = this._normalizeInsights(await this._extractInsights(transcript.text, sessionDoc));

      await Promise.all([
        SessionTranscript.findOneAndUpdate(
          { sessionId },
          {
            sessionId,
            rawText: transcript.text,
            segments: transcript.segments || [],
            language: transcript.language || 'en',
            duration: transcript.duration,
          },
          { upsert: true, new: true }
        ),
        SessionInsight.findOneAndUpdate(
          { sessionId },
          { sessionId, ...insights },
          { upsert: true, new: true }
        ),
        Session.findByIdAndUpdate(sessionId, { pipelineStatus: 'completed' }),
      ]);

      await this._saveToUserDashboard(sessionDoc, insights);

      console.log(`✅ Pipeline completed for session ${sessionId}`);
    } catch (err) {
      console.error(`❌ Pipeline failed for session ${sessionId}:`, err.message);
      await Session.findByIdAndUpdate(sessionId, { pipelineStatus: 'failed' });
    }
    // Source recording is never deleted here (success or failure) — the app no
    // longer touches the .ogg. Raw recordings live under /tmp/recordings and are
    // reaped by the OS (systemd-tmpfiles cleans /tmp at 30 days), so audio is
    // retained ~30 days while the derived transcript/insights persist
    // permanently in MongoDB. Deleting on failure was the bug that made a
    // completed 57-min recording unrecoverable the one time transcription
    // errored. To retry a failed run while the file still exists, POST
    // /api/sessions/:id/reprocess (admin only).
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
${transcriptText.slice(0, 24000)}`,
        },
      ],
      // 24k chars (~6k input tokens) + ~2.5k output keeps a single request under
      // Groq's free-tier 12k tokens-per-minute cap, so it won't 429 on long
      // sessions — while still covering ~35–40 min of conversation (vs the old
      // 6k-char / ~9-min window). If a run does fail, the recording is retained
      // and can be re-run via /api/sessions/:id/reprocess.
      { model: PIPELINE_MODEL, maxTokens: 2560, timeoutMs: 60000 },
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
    const topic     = sessionDoc.topic || 'Career Guidance';
    const mentorName = sessionDoc.mentorName || 'Your Mentor';

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
      ops.push(
        Roadmap.findOneAndUpdate(
          { userId: studentId },
          { $push: { steps: newStep }, $setOnInsert: { userId: studentId, generatedAt: new Date() } },
          { upsert: true }
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
