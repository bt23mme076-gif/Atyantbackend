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
  summary:             { type: String },
  careerContext:       { type: String, enum: ['placement', 'higher_studies', 'skill_gap', 'other'] },
}, { timestamps: true });

const SessionInsight = mongoose.model('SessionInsight', sessionInsightSchema);
export default SessionInsight;
