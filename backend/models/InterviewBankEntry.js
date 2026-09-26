import mongoose from 'mongoose';

const reportSchema = new mongoose.Schema({
  contributorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sourceType   : { type: String, enum: ['senior_form', 'user_report'], required: true },
  interviewYear: { type: Number },
  consentToShow: { type: Boolean, required: true },
  consentedAt  : { type: Date, required: true },
  reportedAt   : { type: Date, default: Date.now }
}, { _id: false });

const interviewBankEntrySchema = new mongoose.Schema({

  company          : { type: String, required: true, trim: true },
  companyNormalized: { type: String, required: true, index: true },
  role             : { type: String, required: true, trim: true },
  roleFamily       : { type: String, required: true, index: true },
  roundType        : { type: String, enum: ['technical', 'hr', 'managerial', 'other'], required: true },
  topic            : { type: String, required: true },

  questionText   : { type: String, required: true, maxlength: 1000 },
  answerHints    : { type: String, maxlength: 1500, default: '' },
  processContext : { type: String, maxlength: 1500, default: '' },

  // Near-duplicate submissions merge into one entry, so reports.length is the
  // number of independent people who were asked this.
  reports    : { type: [reportSchema], default: [] },
  reportCount: { type: Number, default: 0, index: true },

  status: {
    type   : String,
    enum   : ['pending', 'approved', 'rejected'],
    default: 'pending',
    index  : true
  },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  embedding: { type: [Number], select: false }

}, { timestamps: true });

interviewBankEntrySchema.index({ companyNormalized: 1, roleFamily: 1, status: 1 });

interviewBankEntrySchema.pre('save', function (next) {
  this.reportCount = this.reports.length;
  if (this.status === 'approved' && !this.reports.some(r => r.consentToShow)) {
    return next(new Error('Approved bank entries need at least one report with display consent'));
  }
  next();
});

interviewBankEntrySchema.virtual('confidenceTier').get(function () {
  return this.reportCount >= 2 ? 'commonly_asked' : 'reported_once';
});

export default mongoose.model('InterviewBankEntry', interviewBankEntrySchema);
