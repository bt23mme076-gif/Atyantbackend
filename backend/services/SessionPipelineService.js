import fs from 'fs';
import axios from 'axios';
import FormData from 'form-data';
import Session from '../models/Session.js';
import SessionTranscript from '../models/SessionTranscript.js';
import SessionInsight from '../models/SessionInsight.js';
import SavedAnswer from '../models/SavedAnswer.js';
import SessionRoadmap from '../models/SessionRoadmap.js';
import roadmapGenerator from './RoadmapGenerator.js';
import { groqJSON, groqRotate, GROQ_API_KEYS } from '../utils/groqClient.js';

const WHISPER_MODEL   = process.env.GROQ_WHISPER_MODEL  || 'whisper-large-v3';
// In-depth analysis needs a capable model — the 8b "instant" model produced thin,
// generic summaries. 70b-versatile gives a genuinely useful breakdown.
const PIPELINE_MODEL  = process.env.GROQ_PIPELINE_MODEL || 'llama-3.3-70b-versatile';

// Below this, a recording isn't a real session (an early test join, or an egress
// that died before the conversation). We must NOT write junk insights for it, and
// must never let it overwrite/precede the real session's analysis.
const MIN_DURATION_SEC = 90;
const MIN_TRANSCRIPT_CHARS = 200;

class SessionPipelineService {

  // Entry point — called after egress_ended webhook
  async processSession(sessionId, audioPath) {
    await Session.findByIdAndUpdate(sessionId, { pipelineStatus: 'processing' });
    try {
      const transcript = await this._transcribe(audioPath);

      // Guard against junk recordings (early test joins / egress that died before
      // the real session). Bail BEFORE writing anything so we never create a
      // misleading "too short to summarize" summary or overwrite the real one.
      const text = (transcript.text || '').trim();
      const dur  = transcript.duration || 0;
      if (text.length < MIN_TRANSCRIPT_CHARS || dur < MIN_DURATION_SEC) {
        await Session.findByIdAndUpdate(sessionId, { pipelineStatus: 'skipped' });
        this._cleanup(audioPath);
        console.log(`⏭️  Pipeline skipped for session ${sessionId} — recording too short (${Math.round(dur)}s, ${text.length} chars). Likely an early/partial recording.`);
        return;
      }

      const sessionDoc = await Session.findById(sessionId).lean();
      const insights = await this._extractInsights(text, sessionDoc);

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

      this._cleanup(audioPath);
      console.log(`✅ Pipeline completed for session ${sessionId}`);
    } catch (err) {
      console.error(`❌ Pipeline failed for session ${sessionId}:`, err.message);
      await Session.findByIdAndUpdate(sessionId, { pipelineStatus: 'failed' });
      this._cleanup(audioPath);
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
          content: 'You are an expert career-mentorship analyst. You read a transcript of a 1:1 mentor–student session and produce a thorough, specific, useful breakdown for the student to act on. Be concrete and grounded ONLY in what was actually said — never invent advice that was not given. Return ONLY valid JSON, no markdown, no extra text.',
        },
        {
          role: 'user',
          content: `Analyze this mentor–student career guidance session transcript in depth.
Topic: ${sessionDoc?.topic || 'Career Guidance'}

Return ONLY this JSON structure (fill every field from the transcript; use [] or "" if genuinely not discussed):
{
  "summary": "2-3 sentence recap of the session",
  "detailedSummary": "4-8 sentence in-depth narrative: what the student came in with, what was actually discussed, the mentor's main guidance, and how it concluded. Be specific to THIS conversation.",
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
${transcriptText.slice(0, 12000)}`,
        },
      ],
      { model: PIPELINE_MODEL, maxTokens: 2560, timeoutMs: 45000 },
    );
  }

  async _saveToUserDashboard(sessionDoc, insights) {
    const studentId = sessionDoc.userId;
    const mentorId  = sessionDoc.mentorId;
    const topic     = sessionDoc.topic || 'Career Guidance';
    const mentorName = sessionDoc.mentorName || 'Your Mentor';

    const ops = [];

    // Session summary → SavedAnswer (shown in "Saved Answers"). Prefer the
    // in-depth narrative so the student gets the full picture, not one line.
    const summaryText = insights.detailedSummary || insights.summary;
    if (summaryText) {
      ops.push(
        SavedAnswer.create({
          userId:     studentId,
          question:   summaryText,
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

    // Per-session roadmap → AI-generated from THIS session's summary (no longer a
    // hardcoded step). Stored as its own SessionRoadmap so the student can have
    // one roadmap per session and pick between them when they have several.
    ops.push(
      (async () => {
        try {
          const steps = await roadmapGenerator.fromSession({ topic, insights });
          if (!steps.length) return;
          await SessionRoadmap.findOneAndUpdate(
            { sessionId: sessionDoc._id },
            {
              sessionId:  sessionDoc._id,
              userId:     studentId,
              mentorId,
              topic,
              mentorName,
              summary:    insights.detailedSummary || insights.summary || '',
              steps,
              generatedAt: new Date(),
            },
            { upsert: true, new: true }
          );
        } catch (err) {
          console.error('Session roadmap generation failed (non-fatal):', err.message);
        }
      })()
    );

    try {
      await Promise.all(ops);
      console.log(`✅ Dashboard updated for student ${studentId} (${ops.length} items)`);
    } catch (err) {
      console.error('Dashboard save error (non-fatal):', err.message);
    }
  }

  _cleanup(audioPath) {
    if (audioPath && fs.existsSync(audioPath)) {
      fs.unlink(audioPath, err => {
        if (err) console.error('Audio cleanup error:', err.message);
      });
    }
  }
}

export default new SessionPipelineService();
