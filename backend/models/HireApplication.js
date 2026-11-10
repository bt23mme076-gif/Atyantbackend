import mongoose from 'mongoose';

const { Schema } = mongoose;

const evidenceItem = new Schema({ point: String, evidence: String }, { _id: false });

// A candidate's application to a HireJob. Candidates have no Atyant account:
// they hold a random access token (only its hash is stored) that lets them
// check status and join their interview.
const hireApplicationSchema = new Schema({
  jobId      : { type: Schema.Types.ObjectId, ref: 'HireJob', required: true, index: true },
  companyId  : { type: Schema.Types.ObjectId, ref: 'HireCompany', required: true, index: true },
  interviewId: { type: Schema.Types.ObjectId, ref: 'MockInterview', default: null, index: true },

  candidate: {
    name : { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 200 },
    phone: { type: String, required: true, trim: true, maxlength: 20 }
  },
  tokenHash: { type: String, required: true, index: true },
  consentAt: { type: Date, required: true },

  // applied: prep running · ready: interview can start · in_progress · evaluating
  // completed: report ready · failed: prep or evaluation failed
  status: {
    type: String,
    enum: ['applied', 'ready', 'in_progress', 'evaluating', 'completed', 'failed'],
    default: 'applied',
    index: true
  },
  decision: { type: String, enum: ['shortlisted', 'rejected', null], default: null },
  notes   : { type: String, default: '', maxlength: 2000 },

  integrity: {
    tabSwitches    : { type: Number, default: 0 },
    fullscreenExits: { type: Number, default: 0 },
    cameraOffSec   : { type: Number, default: 0 }
  },

  // Denormalized from the evaluation so the dashboard can sort without joins.
  result: {
    overall     : { type: Number, default: null },
    verdict     : { type: String, enum: ['strong_yes', 'yes', 'maybe', 'no', null], default: null },
    coveragePct : { type: Number, default: null },
    summary     : { type: String, default: '' },
    strengths   : [evidenceItem],
    concerns    : [evidenceItem],
    redFlags    : [evidenceItem],
    skillFit    : [{ skill: String, level: String, evidence: String, _id: false }],
    claims      : [{ claim: String, outcome: String, score: Number, _id: false }],
    nextRoundQuestions: [{ type: String }],
    completedAt : { type: Date, default: null }
  },
  billed: { type: Boolean, default: false }
}, { timestamps: true });

hireApplicationSchema.index({ jobId: 1, 'candidate.email': 1 }, { unique: true });
hireApplicationSchema.index({ jobId: 1, 'candidate.phone': 1 }, { unique: true });
hireApplicationSchema.index({ jobId: 1, 'result.overall': -1 });

export default mongoose.model('HireApplication', hireApplicationSchema);
