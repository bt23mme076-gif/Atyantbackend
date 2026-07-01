import mongoose from 'mongoose';

// ─────────────────────────────────────────────
//  REUSABLE SUB-SCHEMA  (used in main + follow-ups)
// ─────────────────────────────────────────────
const answerContentSchema = new mongoose.Schema({
  mainAnswer       : { type: String, default: '' },
  situation        : { type: String, default: '' },
  firstAttempt     : { type: String, default: '' },
  // 🔴 FIX: [Object] → typed arrays so Mongoose can validate
  keyMistakes      : [{ type: String }],
  whatWorked       : { type: String, default: '' },
  actionableSteps  : [{
    step        : { type: String },
    description : { type: String }
  }],
  timeline         : { type: String, default: '' },
  differentApproach: { type: String, default: '' },
  additionalNotes  : { type: String, default: '' }
}, { _id: false });

// ─────────────────────────────────────────────
//  FOLLOW-UP SUB-SCHEMA
// ─────────────────────────────────────────────
const followUpSchema = new mongoose.Schema({
  questionText      : { type: String, required: true },
  questionId        : { type: mongoose.Schema.Types.ObjectId, ref: 'Question' },
  answerContent     : { type: answerContentSchema, default: () => ({}) },
  mentorExperienceId: { type: mongoose.Schema.Types.ObjectId, ref: 'MentorExperience' },
  askedAt           : { type: Date, default: Date.now },
  answeredAt        : { type: Date, default: null }
}, { _id: false });

// ─────────────────────────────────────────────
//  MAIN SCHEMA
// ─────────────────────────────────────────────
const answerCardSchema = new mongoose.Schema({
  questionId: {
    type    : mongoose.Schema.Types.ObjectId,
    ref     : 'Question',
    required: true,
    index   : true   // 🔴 FIX: index added
  },

  mentorId: {
    type    : mongoose.Schema.Types.ObjectId,
    ref     : 'User',
    required: true,
    index   : true   // 🔴 FIX: index added
  },

  mentorExperienceId: {
    type    : mongoose.Schema.Types.ObjectId,
    ref     : 'MentorExperience',
    required: false
  },

  // 🔥 Vector embedding — select: false keeps it out of default queries
  embedding: {
    type    : [Number],
    required: false,
    select  : false
  },

  answerContent: {
    type   : answerContentSchema,
    default: () => ({})
  },

  audioUrl  : { type: String, default: null },
  transcript: { type: String, default: null },

  trustMessage: {
    type   : String,
    default: 'This answer is built from real experience, not AI-generated advice.'
  },

  signature: {
    type   : String,
    default: '— Atyant Expert Mentor'
  },

  followUpCount: {
    type   : Number,
    default: 0,
    max    : 2
  },

  followUpAnswers: [followUpSchema],

  userFeedback: {
    helpful: { type: Boolean, default: null },
    rating : { type: Number, min: 1, max: 5, default: null },
    comment: { type: String, maxlength: 500, default: '' }
  },

  deliveredAt: { type: Date, default: null }

}, {
  // 🔴 FIX: Use built-in timestamps instead of manual updatedAt/createdAt
  timestamps: true
});

// ─────────────────────────────────────────────
//  COMPOUND INDEX: mentor's answer history page
// ─────────────────────────────────────────────
answerCardSchema.index({ mentorId: 1, createdAt: -1 });

// ─────────────────────────────────────────────
//  FEEDBACK INDEX: analytics queries
// ─────────────────────────────────────────────
answerCardSchema.index({ 'userFeedback.rating': 1 }, { sparse: true });

const AnswerCard = mongoose.model('AnswerCard', answerCardSchema);
export default AnswerCard;
