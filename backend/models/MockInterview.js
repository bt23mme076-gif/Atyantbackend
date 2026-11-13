import mongoose from 'mongoose';

const { Schema } = mongoose;

// ── Parsed inputs ────────────────────────────────────────────────────────────
// Every item the planner can reference carries a short stable id (jd_s1, cc1,
// c1…) so plan questions point at evidence instead of restating it.

const jdSkillSchema = new Schema({
  id      : { type: String, required: true },
  name    : { type: String, required: true },
  required: { type: Boolean, default: true },
  span    : { type: String, default: '' }
}, { _id: false });

const companyContextSchema = new Schema({
  id  : { type: String, required: true },
  fact: { type: String, required: true },
  span: { type: String, required: true }
}, { _id: false });

const projectSchema = new Schema({
  id     : { type: String, required: true },
  name   : { type: String, required: true },
  kind   : { type: String, enum: ['project', 'internship', 'other'], default: 'project' },
  tech   : [{ type: String }],
  summary: { type: String, default: '' }
}, { _id: false });

const claimSchema = new Schema({
  id               : { type: String, required: true },
  claim            : { type: String, required: true },
  type             : { type: String, enum: ['metric', 'tech_choice', 'ownership', 'outcome', 'skill_listed'], required: true },
  projectId        : { type: String, default: null },
  evidenceSpan     : { type: String, required: true },
  defensibilityRisk: { type: String, enum: ['low', 'medium', 'high'], required: true },
  riskReason       : { type: String, default: '' },
  probeLadder      : [{ type: String }]
}, { _id: false });

// ── Plan ─────────────────────────────────────────────────────────────────────

const expectedPointSchema = new Schema({
  id    : { type: String, required: true },
  point : { type: String, required: true },
  weight: { type: Number, min: 1, max: 3, default: 1 }
}, { _id: false });

const plannedQuestionSchema = new Schema({
  qid  : { type: String, required: true },
  order: { type: Number, required: true },
  phase: { type: String, enum: ['intro', 'resume', 'technical', 'behavioral', 'closing'], required: true },

  // Set by planValidator from ref.type, never taken from LLM output. 'coding'
  // and 'sql_exercise' are injected in code from a curated bank (PlannerService),
  // never produced by the planner LLM.
  source: { type: String, enum: ['bank', 'resume', 'jd', 'core', 'coding', 'sql_exercise', 'employer'], required: true },
  ref   : {
    type: { type: String, enum: ['bank', 'claim', 'jd_skill', 'core', 'coding', 'sql_exercise', 'employer'], required: true },
    id  : { type: String, required: true }
  },
  bankEntryId      : { type: Schema.Types.ObjectId, ref: 'InterviewBankEntry', default: null },
  confidenceTier   : { type: String, enum: ['commonly_asked', 'reported_once', null], default: null },
  companyContextIds: [{ type: String }],

  topic         : { type: String, required: true },
  intent        : { type: String, required: true },
  difficulty    : { type: Number, min: 1, max: 5, required: true },
  text          : { type: String, required: true },
  expectedPoints: { type: [expectedPointSchema], required: true },
  followUps     : {
    shallow     : { type: String, default: '' },
    wrong       : { type: String, default: '' },
    strongDeeper: { type: String, default: '' }
  },
  maxFollowUps: { type: Number, default: 2 }
}, { _id: false });

// ── Live turns and evaluation ────────────────────────────────────────────────

const turnSchema = new Schema({
  qid       : { type: String, required: true },
  kind      : { type: String, enum: ['planned', 'follow_up'], required: true },
  trigger   : { type: String, enum: ['shallow', 'wrong', 'strongDeeper', null], default: null },
  capture   : { type: String, enum: ['captured', 'uncertain', 'not_heard'], default: 'captured' },
  text      : { type: String, required: true },
  answer    : { type: String, default: '' },
  verdict   : { type: String, enum: ['strong', 'shallow', 'wrong', 'skip', null], default: null },
  askedAt   : { type: Date },
  answeredAt: { type: Date }
}, { _id: false });

const answerEvalSchema = new Schema({
  qid        : { type: String, required: true },
  pointsHit  : [{
    pointId : String,
    hit     : { type: String, enum: ['full', 'partial', 'none'] },
    evidence: String
  }],
  // Not reached = the interview ended before this question was asked.
  reached      : { type: Boolean, default: true },
  runScores    : [{ type: Number }],
  score        : { type: Number, min: 0, max: 5 },
  communication: { type: Number, min: 1, max: 5 },
  confidence   : { type: Number, min: 1, max: 5 },
  whatWentWell : { type: String, default: '' },
  missing      : [{ type: String }],
  feedback     : { type: String, default: '' },
  sampleAnswer : { type: String, default: '' }
}, { _id: false });

const mockInterviewSchema = new Schema({

  // 'hiring' interviews belong to a HireApplication: the candidate has no
  // account, so there is no userId and the agent waits for `cand_<applicationId>`.
  mode: { type: String, enum: ['mock', 'hiring'], default: 'mock', index: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: function () { return this.mode !== 'hiring'; }, index: true },
  hire: {
    jobId        : { type: Schema.Types.ObjectId, ref: 'HireJob', default: null },
    applicationId: { type: Schema.Types.ObjectId, ref: 'HireApplication', default: null },
    candidateName: { type: String, default: '' },
    mustAsk      : { type: Array, default: [] },
    // Copied from the job when the candidate applies; null = the 15-minute default.
    durationMin  : { type: Number, default: null },
    questionCount: { type: Number, default: null }
  },

  status: {
    type   : String,
    // planned → voicing (pre-made audio is recorded) → ready → live
    enum   : ['draft', 'parsing', 'parsed', 'planning', 'planned', 'voicing', 'ready', 'live', 'evaluating', 'completed', 'failed'],
    default: 'draft',
    index  : true
  },

  roleFamily: { type: String, default: null },
  seniority : { type: String, enum: ['intern', 'fresher', 'experienced'], default: 'fresher' },
  company   : { type: String, default: '' },
  role      : { type: String, default: '' },
  // User-picked (or auto-detected) interview focus. Drives mandatory topics in
  // the planner (e.g. DSA for tech, guesstimate+puzzle for analytics) on top of
  // whatever roleFamily the JD parser infers.
  interviewCategory: { type: String, enum: ['tech', 'analytics', 'core', 'business', 'product', 'hr', null], default: null },

  inputs: {
    jdText       : { type: String, default: '' },
    jdSource     : { type: String, enum: ['text', 'pdf'], default: 'text' },
    resumeText   : { type: String, default: '' },
    resumeSource : { type: String, enum: ['upload', 'profile', 'text'], default: 'upload' }
  },

  prepAttempts: { type: Number, default: 0 },

  // Starting an interview is paid (entryPayment); the full report is a separate
  // unlock (payment) unless the first-interview bundle was bought. 'free_trial'
  // is legacy: no longer granted, but still treated as unlocked.
  access: {
    plan      : { type: String, enum: ['locked', 'free_trial', 'paid'], default: 'locked' },
    unlockedAt: { type: Date, default: null }
  },
  // ₹10 to start the interview (older interviews: ₹99, or ₹149 bundle)
  entryPayment: {
    orderId  : { type: String, default: null, index: true },
    paymentId: { type: String, default: null },
    amount   : { type: Number, default: null },   // rupees
    starter  : { type: Boolean, default: false }, // ₹10 plan: 15-minute interview
    reportIncluded: { type: Boolean, default: false }, // the full report came with this payment
    waived   : { type: Boolean, default: false }, // free account: nothing was charged
    status   : { type: String, enum: ['created', 'paid', null], default: null },
    createdAt: { type: Date, default: null },     // when the order was opened (checkout nudge)
    nudgedAt : { type: Date, default: null },     // WhatsApp "still waiting" sent
    paidAt   : { type: Date, default: null }
  },
  // ₹49 full-report add-on
  payment: {
    orderId  : { type: String, default: null, index: true },
    paymentId: { type: String, default: null },
    amount   : { type: Number, default: null },   // rupees
    status   : { type: String, enum: ['created', 'paid', null], default: null },
    paidAt   : { type: Date, default: null }
  },

  parsed: {
    jd: {
      requiredSkills  : [jdSkillSchema],
      niceToHave      : [jdSkillSchema],
      responsibilities: [{ type: String }],
      companyContext  : [companyContextSchema]
    },
    resume: {
      projects: [projectSchema],
      skills  : [{ name: String, evidenced: Boolean, _id: false }],
      claims  : [claimSchema]
    },
    gap: {
      matches: [{ type: String }],
      gaps   : [{ type: String }]
    },
    log: [{ type: String }]
  },

  failureReason: { type: String, default: '' },

  blueprint: {
    strengths    : [{ type: String }],
    weakSpots    : [{ type: String }],
    bankHits     : { type: Number, default: 0 },
    coverageNote : { type: String, default: '' }
  },

  plan: {
    questions    : [plannedQuestionSchema],
    plannerModel : { type: String, default: '' },
    criticRounds : { type: Number, default: 0 },
    validationLog: [{ type: String }],
    plannedAt    : { type: Date }
  },

  live: {
    roomName    : { type: String, default: '' },
    dispatchedAt: { type: Date, default: null },
    startedAt   : { type: Date, default: null },
    endedAt  : { type: Date, default: null },
    endReason: { type: String, enum: ['completed', 'time_up', 'student_left', 'error', 'no_show', 'stale', null], default: null },
    // One entry per interviewer reply: candidate's end of speech → first audio.
    // gapMs counts from when they actually stopped (VAD detection minus its
    // silence window); detectedMs from when the agent noticed.
    turnGaps: [{
      at        : Date,
      qid       : String,
      gapMs     : Number,
      detectedMs: Number,
      voice     : String,
      first     : { type: String, enum: ['clip', 'live'] },
      _id       : false
    }],
    // The interview voice failed on a live line and the other voice was used.
    voiceSwitches: [{ at: Date, from: String, to: String, reason: String, _id: false }]
  },

  // One voice for the whole interview, picked and recorded before it starts.
  voice: {
    role      : { type: String, enum: ['main', 'backup', null], default: null },
    model     : { type: String, default: '' },
    voice     : { type: String, default: '' },
    healthMs  : { type: Number, default: null },
    folder    : { type: String, default: '' },  // Cloudinary prefix holding this interview's clips
    clips     : [{ key: String, text: String, url: String, sampleRate: Number, _id: false }],
    voicedAt  : { type: Date, default: null },
    log       : [{ type: String }]
  },

  turns: [turnSchema],

  // Scores are 0-5 per question; dimensions and overall are 0-100. A dimension
  // is null when the interview had no questions for it (e.g. no technical phase).
  evaluation: {
    perAnswer : [answerEvalSchema],
    dimensions: {
      technicalDepth   : { type: Number, default: null },
      resumeCredibility: { type: Number, default: null },
      behavioral       : { type: Number, default: null },
      communication    : { type: Number, default: null },
      confidence       : { type: Number, default: null },
      problemSolving   : { type: Number, default: null },
      starCompleteness : { type: Number, default: null }
    },
    overall     : { type: Number, default: null },
    summary     : { type: String, default: '' },
    strengths   : [{ type: String }],
    improvements: [{ type: String }],
    prepPath    : [{ topic: String, why: String, action: String, basedOn: [String], _id: false }],
    evaluatorModel: { type: String, default: '' },
    attempts    : { type: Number, default: 0 },
    startedAt   : { type: Date, default: null },
    log         : [{ type: String }],
    completedAt : { type: Date }
  },

  attempt          : { type: Number, default: 1 },
  parentInterviewId: { type: Schema.Types.ObjectId, ref: 'MockInterview', default: null },
  // First attempt in the chain; retakes of retakes all point at it.
  rootInterviewId  : { type: Schema.Types.ObjectId, ref: 'MockInterview', default: null, index: true },
  retestTopics     : [{ type: String }]

}, { timestamps: true });

export default mongoose.model('MockInterview', mockInterviewSchema);
