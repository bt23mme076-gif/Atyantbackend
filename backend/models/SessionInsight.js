import mongoose from 'mongoose';

const sessionInsightSchema = new mongoose.Schema({
  sessionId:         { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true, unique: true, index: true },
  topics:            [{ type: String }],
  studentPainPoints: [{
    point:     { type: String },
    timestamp: { type: String },
  }],
  actionItems: {
    student: [{ type: String }],
    mentor:  [{ type: String }],
  },
  mentorQualityScore:  { type: Number, min: 1, max: 10 },
  mentorQualityReason: { type: String },
  studentSentiment:    { type: String, enum: ['positive', 'neutral', 'negative'] },
  summary:             { type: String },                 // short 2-3 sentence recap (cards)
  careerContext:       { type: String, enum: ['placement', 'higher_studies', 'skill_gap', 'other'] },

  // ── In-depth analysis (richer dashboard view) ──
  detailedSummary:      { type: String },                // multi-paragraph narrative of the session
  keyDiscussionPoints:  [{ type: String }],              // the main things actually discussed
  strengths:            [{ type: String }],              // what the student is doing well
  areasToImprove:       [{ type: String }],              // concrete gaps to work on
  recommendedResources: [{ type: String }],              // books / courses / tools the mentor suggested
  nextSessionFocus:     [{ type: String }],              // what the next session should cover
}, { timestamps: true });

const SessionInsight = mongoose.model('SessionInsight', sessionInsightSchema);
export default SessionInsight;
