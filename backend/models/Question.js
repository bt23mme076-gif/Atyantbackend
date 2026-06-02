import mongoose from 'mongoose';

const questionSchema = new mongoose.Schema({

  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  title: {
    type: String,
    required: false,
    trim: true,
    minlength: 10,
    maxlength: 200,
    default: function () {
      return this.questionText ? this.questionText.substring(0, 50) : '';
    }
  },

  questionText: {
    type: String,
    required: true,
    trim: true,
    minlength: 10,
    maxlength: 1000
  },

  category: {
    type: String,
    required: false,
    enum: [
      'Tech', 'Data Analytics', 'Consulting', 'Product', 'Core Engineering',
      'Academic & College Life', 'Technical Skills', 'Career Growth',
      'Personal Development', 'Entrepreneurship'
    ],
    default: 'Tech'
  },

  reason: { type: String, trim: true, maxlength: 500, default: '' },
  qualityScore: { type: Number, min: 0, max: 100, default: 0 },
  keywords: [{ type: String, trim: true }],

  selectedMentorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true
  },

  matchPercentage: { type: Number, min: 0, max: 100, default: 0 },
  selectionReason: { type: String, default: '' },

  status: {
    type: String,
    enum: [
      'draft', 'submitted', 'pending', 'mentor_assigned',
      'awaiting_experience', 'experience_submitted',
      'answer_generated', 'delivered', 'answered_instantly', 'failed'
    ],
    default: 'draft',
    index: true
  },

  answerCardId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AnswerCard',
    default: null
  },

  followUpQuestions: [{
    questionText: String,
    questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question' },
    askedAt: { type: Date, default: Date.now },
    answerCardId: { type: mongoose.Schema.Types.ObjectId, ref: 'AnswerCard' }
  }],

  isFollowUp: { type: Boolean, default: false },
  parentQuestionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', default: null },

  // ─── PAYMENT ───────────────────────────────
  isPaid: { type: Boolean, default: false },
  paidMentorshipType: {
    type: String,
    enum: ['chat', 'video', 'roadmap', null],
    default: null
  },
  paidAt: { type: Date, default: null },

  // ─── EDIT WINDOW ───────────────────────────
  lastEditedAt: { type: Date, default: null },
  isEditable: { type: Boolean, default: true },

  // ─── VECTOR / MATCHING ─────────────────────
  isInstant: { type: Boolean, default: false },
  matchScore: { type: Number, min: 0, max: 100, default: null },

  matchMethod: {
    type: String,
    enum: [
      'vector_semantic',
      'live_routing',
      'pending_assignment',
      'atyant_engine_fallback',
      'retry_exhausted',
      'user_selected',
      null
    ],
    default: null
  },

  // ─── FEEDBACK ──────────────────────────────
  studentFeedback: {
    type: String,
    enum: ['helpful', 'not_helpful', null],
    default: null,
  },
  feedbackAt: {
    type: Date,
  },

}, {
  timestamps: true,
  toJSON: { virtuals: true, getters: true },
  toObject: { virtuals: true, getters: true }
});

// ─────────────────────────────────────────────
//  COMPOUND INDEXES
// ─────────────────────────────────────────────
// Mentor dashboard: pending questions
questionSchema.index({ selectedMentorId: 1, status: 1, createdAt: -1 });

// Student history
questionSchema.index({ userId: 1, isFollowUp: 1, createdAt: -1 });

// Feedback analytics
questionSchema.index({ selectedMentorId: 1, studentFeedback: 1 });

// ─────────────────────────────────────────────
//  VIRTUALS
// ─────────────────────────────────────────────
questionSchema.virtual('description')
  .get(function () { return this.questionText; })
  .set(function (v) { this.questionText = v; });

// ─────────────────────────────────────────────
//  METHODS
// ─────────────────────────────────────────────
questionSchema.methods.checkEditable = function () {
  if (!this.createdAt) return false;
  return (Date.now() - this.createdAt.getTime()) < 5 * 60 * 1000 && this.status === 'submitted';
};

// ─────────────────────────────────────────────
//  PRE-SAVE
// ─────────────────────────────────────────────
questionSchema.pre('save', function (next) {
  if (!this.isNew && this.status !== 'draft') {
    this.isEditable = this.checkEditable();
  }
  next();
});


const Question = mongoose.model('Question', questionSchema);
export default Question;