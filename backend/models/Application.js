import mongoose from 'mongoose';

const applicationSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  job: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    required: true,
  },
  mode: {
    type: String,
    enum: ['auto', 'manual'],
    default: 'auto',
  },
  status: {
    type: String,
    enum: ['queued', 'submitted', 'failed', 'needs_manual_action'],
    default: 'queued',
    index: true,
  },
  matchScoreAtQueue: { type: Number, default: null },
  resumeUrlUsed: { type: String, default: '' },
  coverLetterText: { type: String, default: '' },
  confirmationText: { type: String, default: '' },
  screenshotUrl: { type: String, default: '' },
  reason: { type: String, default: '' }, // why failed / why needs_manual_action
  unansweredQuestions: [{
    id: String,
    name: String,
    label: String,
    isCombobox: Boolean,
  }],
  submittedAt: { type: Date, default: null },
}, { timestamps: true });

// One application per (user, job) — the auto-apply engine must never double-submit.
applicationSchema.index({ user: 1, job: 1 }, { unique: true });

const Application = mongoose.model('Application', applicationSchema);
export default Application;
