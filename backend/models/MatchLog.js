import mongoose from 'mongoose';

// ─────────────────────────────────────────────
//  MATCH LOG — append-only routing log.
//  Every match decision is recorded with the full candidate set and feature
//  breakdowns. Feedback and outcomes are written back later as labels.
//  This collection IS the future learning-to-rank training set — it cannot
//  be backfilled, so we capture it from day one.
// ─────────────────────────────────────────────
const candidateSchema = new mongoose.Schema({
  mentorId : { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  score    : { type: Number, default: 0 },    // finalScore (vector) or points (live)
  baseScore: { type: Number, default: null }, // raw semantic score (vector path only)
  breakdown: { type: String, default: '' },   // feature breakdown at decision time
}, { _id: false });

const matchLogSchema = new mongoose.Schema({
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', default: null, index: true },
  studentId : { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

  path: { type: String, enum: ['vector', 'live', 'clarity'], required: true },

  questionText  : { type: String, default: '' },
  queryDetails  : { type: mongoose.Schema.Types.Mixed, default: null }, // intent, companies, tags…
  studentContext: { type: mongoose.Schema.Types.Mixed, default: null }, // college, branch, year, goal

  candidates      : [candidateSchema], // top 10 at decision time
  selectedMentorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  instant         : { type: Boolean, default: false },

  // ─── LABELS (written back later) ───────────
  feedback: { type: String, enum: ['helpful', 'not_helpful', null], default: null },
  outcome : { type: String, enum: ['achieved', 'not_achieved', null], default: null },
}, { timestamps: true });

matchLogSchema.index({ createdAt: -1 });
matchLogSchema.index({ selectedMentorId: 1, feedback: 1 });

const MatchLog = mongoose.model('MatchLog', matchLogSchema);
export default MatchLog;
