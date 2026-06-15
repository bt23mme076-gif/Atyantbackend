import fs from 'fs';
import axios from 'axios';
import FormData from 'form-data';
import Session from '../models/Session.js';
import SessionTranscript from '../models/SessionTranscript.js';
import SessionInsight from '../models/SessionInsight.js';
import SavedAnswer from '../models/SavedAnswer.js';
import Roadmap from '../models/Roadmap.js';

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const WHISPER_MODEL   = process.env.GROQ_WHISPER_MODEL  || 'whisper-large-v3';
const PIPELINE_MODEL  = process.env.GROQ_PIPELINE_MODEL || 'llama-3.1-8b-instant';

class SessionPipelineService {

  // Entry point — called after egress_ended webhook
  async processSession(sessionId, audioPath) {
    await Session.findByIdAndUpdate(sessionId, { pipelineStatus: 'processing' });
    try {
      const transcript = await this._transcribe(audioPath);
      const sessionDoc = await Session.findById(sessionId).lean();
      const insights = await this._extractInsights(transcript.text, sessionDoc);

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
    if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured');
    if (!fs.existsSync(audioPath)) throw new Error(`Audio file not found: ${audioPath}`);

    const form = new FormData();
    form.append('file', fs.createReadStream(audioPath), {
      filename: 'audio.ogg',
      contentType: 'audio/ogg',
    });
    form.append('model', WHISPER_MODEL);
    form.append('response_format', 'verbose_json');
    form.append('language', 'en');

    const response = await axios.post(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        maxBodyLength: Infinity,
      }
    );

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
    if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured');

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: PIPELINE_MODEL,
        temperature: 0.3,
        max_tokens: 1024,
        messages: [
          {
            role: 'system',
            content: 'You are a session analysis AI. Return ONLY valid JSON, no markdown, no extra text.',
          },
          {
            role: 'user',
            content: `/no_think
Analyze this mentor-student career guidance session transcript.
Topic: ${sessionDoc?.topic || 'Career Guidance'}

Return ONLY this JSON structure:
{
  "topics": ["string"],
  "studentPainPoints": [{ "point": "string", "timestamp": "string" }],
  "actionItems": { "student": ["string"], "mentor": ["string"] },
  "mentorQualityScore": 7,
  "mentorQualityReason": "string",
  "studentSentiment": "positive",
  "summary": "2-3 sentence summary",
  "careerContext": "placement"
}

Valid values — studentSentiment: positive|neutral|negative
Valid values — careerContext: placement|higher_studies|skill_gap|other

Transcript:
${transcriptText.slice(0, 6000)}`,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const raw = response.data.choices?.[0]?.message?.content || '{}';
    try {
      const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    } catch {
      console.warn('Insight JSON parse failed, using empty');
      return {};
    }
  }

  async _saveToUserDashboard(sessionDoc, insights) {
    const studentId = sessionDoc.userId;
    const mentorId  = sessionDoc.mentorId;
    const topic     = sessionDoc.topic || 'Career Guidance';
    const mentorName = sessionDoc.mentorName || 'Your Mentor';

    const ops = [];

    // Session summary → SavedAnswer (shown in "Saved Answers")
    if (insights.summary) {
      ops.push(
        SavedAnswer.create({
          userId:     studentId,
          question:   insights.summary,
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

    // Action items → new phase in student's roadmap
    if (actionItems.length) {
      const sessionDate = new Date(sessionDoc.scheduledAt || Date.now())
        .toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

      const newStep = {
        phase:    `Session – ${sessionDate}`,
        title:    `${mentorName} — ${topic}`,
        duration: '2–4 weeks',
        status:   'active',
        tasks:    actionItems.slice(0, 6),
      };

      ops.push(
        Roadmap.findOneAndUpdate(
          { userId: studentId },
          { $push: { steps: newStep } },
          { upsert: false }
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

  _cleanup(audioPath) {
    if (audioPath && fs.existsSync(audioPath)) {
      fs.unlink(audioPath, err => {
        if (err) console.error('Audio cleanup error:', err.message);
      });
    }
  }
}

export default new SessionPipelineService();
