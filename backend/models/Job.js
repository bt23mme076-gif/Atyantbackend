import mongoose from 'mongoose';

const jobSchema = new mongoose.Schema({
  source: {
    type: String,
    enum: ['greenhouse', 'lever', 'firecrawl'],
    required: true,
    index: true,
  },
  sourceJobId: {
    type: String,
    required: true,
  },
  company: {
    type: String,
    required: true,
    trim: true,
    index: true,
  },
  title: {
    type: String,
    required: true,
    trim: true,
  },
  location: {
    type: String,
    trim: true,
    default: '',
  },
  department: {
    type: String,
    trim: true,
    default: '',
  },
  descriptionText: {
    type: String,
    default: '',
  },
  applyUrl: {
    type: String,
    required: true,
  },
  // True only when applyUrl points at the ATS's own hosted form. Many companies
  // embed Greenhouse/Lever behind their own careers site, where the form isn't
  // reachable by URL — those can only be applied to by hand.
  autoApplySupported: {
    type: Boolean,
    default: false,
    index: true,
  },
  postedAt: {
    type: Date,
    default: null,
  },
  status: {
    type: String,
    enum: ['open', 'closed'],
    default: 'open',
    index: true,
  },
  lastSeenAt: {
    type: Date,
    default: Date.now,
  },
}, { timestamps: true });

// One posting per (source, sourceJobId) — used as the upsert key during sync.
jobSchema.index({ source: 1, sourceJobId: 1 }, { unique: true });

const Job = mongoose.model('Job', jobSchema);
export default Job;
