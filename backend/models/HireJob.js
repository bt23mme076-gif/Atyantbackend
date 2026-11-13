import mongoose from 'mongoose';

const { Schema } = mongoose;

// One opening. The JD is parsed once here and copied into every candidate's
// MockInterview, so candidates are assessed against the same skills. The
// founder's must-ask questions are asked to every candidate, in the same order.
const skillSchema = new Schema({
  id      : { type: String, required: true },
  name    : { type: String, required: true },
  required: { type: Boolean, default: true },
  span    : { type: String, default: '' }
}, { _id: false });

const mustAskSchema = new Schema({
  text          : { type: String, required: true, maxlength: 400 },
  topic         : { type: String, default: '' },
  intent        : { type: String, default: '' },
  expectedPoints: [{ id: String, point: String, weight: { type: Number, default: 1 }, _id: false }],
  followUps     : {
    shallow     : { type: String, default: '' },
    wrong       : { type: String, default: '' },
    strongDeeper: { type: String, default: '' }
  }
}, { _id: false });

const hireJobSchema = new Schema({
  companyId  : { type: Schema.Types.ObjectId, ref: 'HireCompany', required: true, index: true },
  ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title      : { type: String, required: true, trim: true, maxlength: 120 },
  slug       : { type: String, required: true, unique: true },
  jdText     : { type: String, required: true },

  // draft → parsing → ready (founder reviews) → live ⇄ paused → closed
  status: {
    type: String,
    enum: ['parsing', 'ready', 'live', 'paused', 'closed', 'failed'],
    default: 'parsing',
    index: true
  },
  failureReason: { type: String, default: '' },

  interviewCategory: { type: String, enum: ['tech', 'analytics', 'core', 'business', 'product', 'hr', null], default: null },

  parsed: {
    company   : { type: String, default: '' },
    role      : { type: String, default: '' },
    seniority : { type: String, enum: ['intern', 'fresher', 'experienced'], default: 'fresher' },
    roleFamily: { type: String, default: null },
    jd: {
      requiredSkills  : [skillSchema],
      niceToHave      : [skillSchema],
      responsibilities: [{ type: String }],
      companyContext  : [{ id: String, fact: String, span: String, _id: false }]
    },
    log: [{ type: String }]
  },

  settings: {
    mustAsk      : { type: [mustAskSchema], default: [] },
    maxCandidates: { type: Number, default: 200, min: 1, max: 5000 },
    deadline     : { type: Date, default: null },
    requireCamera: { type: Boolean, default: true },
    // Founder-chosen interview length. questionCount counts every question the
    // candidate answers (intro and must-ask included, the closing one excluded).
    durationMin  : { type: Number, default: 15, min: 5, max: 15 },
    questionCount: { type: Number, default: 10, min: 3, max: 10 }
  },

  stats: {
    applied  : { type: Number, default: 0 },
    completed: { type: Number, default: 0 }
  },
  publishedAt: { type: Date, default: null }
}, { timestamps: true });

export default mongoose.model('HireJob', hireJobSchema);
