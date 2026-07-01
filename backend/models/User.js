import mongoose from 'mongoose';



const userSchema = new mongoose.Schema({



  // ─── ROLE & IDENTITY ───────────────────────

  googleId: {

    type: String,

    unique: true,

    sparse: true,

    index: true

  },



  role: {

    type: String,

    enum: ['user', 'mentor', 'admin'],

    default: 'user',

    index: true

  },



  username: {

    type: String,

    required: function () { return !this.googleId; },

    unique: true,

    sparse: true,

    trim: true,

    minlength: 3,

    maxlength: 50

  },



  slug: {

    type: String,

    unique: true,

    sparse: true,

    trim: true,

    lowercase: true,

    minlength: 3,

    maxlength: 100

  },



  name: {

    type: String,

    trim: true,

    maxlength: 100,

    default: null

  },



  email: {

    type: String,

    required: true,

    unique: true,

    trim: true,

    lowercase: true

  },



  password: {

    type: String,

    required: function () { return !this.googleId; },

    minlength: 8,

    select: false

  },



  phone: {

    type: String,

    unique: true,

    sparse: true,

    trim: true

  },



  // ─── MENTOR MATCHING FIELDS ────────────────

  primaryDomain: {

    type: String,

    enum: ['placement', 'internship', 'both', null],

    default: null

  },



  topCompanies: [{ type: String }],

  milestones: [{ type: String }],

  specialTags: [{ type: String }],



  companyDomain: {

    type: String,

    enum: ['Tech', 'Data Analytics', 'Consulting', 'Product', 'Core Engineering', null],

    default: null

  },



  tier: { type: Number, default: 1 },



  // ─── PROFILE ───────────────────────────────

  profilePicture: { type: String, default: null },

  bio: { type: String, default: null, maxlength: 500 },

  city: { type: String, default: '' },



  // ─── SKILLS ────────────────────────────────

  skills: [{ type: String, trim: true }],

  expertise: { type: [String], default: [] },

  interests: { type: [String], default: [] },

  domainExperience: { type: [String], default: [] },



  // ─── EDUCATION ─────────────────────────────

  education: [{

    institutionName: { type: String },

    institution: { type: String },

    degree: { type: String },

    field: { type: String },

    year: { type: String },

    cgpa: { type: Number }

  }],



  // ─── SOCIAL ────────────────────────────────

  linkedinProfile: { type: String, default: '' },

  socialLinks: { type: Map, of: String, default: {} },



  // ─── VERIFICATION ──────────────────────────

  isVerified: { type: Boolean, default: false },

  verificationToken: { type: String, select: false },



  // ─── PASSWORD RESET ────────────────────────

  passwordResetToken: { type: String, select: false },

  passwordResetExpires: { type: Date, select: false },

  resetOTP: {

    type: String,

    select: false

  },



  resetOTPExpires: {

    type: Date,

    select: false

  },



  // ─── LOCATION ──────────────────────────────

  location: {

    type: {

      type: String,

      enum: ['Point'],

      required: false

    },

    coordinates: {

      type: [Number],

      required: false,

      validate: {

        validator: v => !v || v.length === 0 || (Array.isArray(v) && v.length === 2 && !isNaN(v[0]) && !isNaN(v[1])),

        message: 'Coordinates must be [longitude, latitude]'

      }

    },

    city: { type: String, default: null },

    state: { type: String, default: null },

    country: { type: String, default: 'India' },

    lastUpdated: { type: Date, default: null }

  },



  // ─── MENTOR OPERATIONAL FIELDS ─────────────

  price: { type: Number, default: 0, min: 0 },

  // Which platform services this mentor offers (ids from config/serviceCatalog.js).

  // Prices are platform-fixed; mentors only choose what they offer.

  servicesOffered: { type: [String], default: [] },

  // Weekly recurring availability — each entry is a day-of-week + time slots.

  // day: 0=Sun 1=Mon … 6=Sat, slots: ["09:00","10:00",...] in IST (HH:MM).

  availability: {

    weekly: [{ day: { type: Number, min: 0, max: 6 }, slots: [{ type: String }] }],

    timezone:           { type: String, default: 'Asia/Kolkata' },

    advanceNoticeHours: { type: Number, default: 2 },

    maxWeeksAhead:      { type: Number, default: 3 },

  },

  acceptsCredits: { type: Boolean, default: false },

  isOnline: { type: Boolean, default: false },

  lastActive: { type: Date, default: Date.now, index: true },

  yearsOfExperience: { type: Number, default: 0 },

  chatDisabled: { type: Boolean, default: false },

  isStrategyComplete: { type: Boolean, default: false },



  // Whether this mentor is listed in the live matching pool. Set true once they

  // complete onboarding (passes the completeness gate). Existing/imported mentors

  // have this undefined, which is treated as listed (engine filters on `$ne false`).

  mentorListed: { type: Boolean, default: true },

  mentorOnboardedAt: { type: Date, default: null },



  // ─── MENTOR STATS ──────────────────────────

  profileViews: { type: Number, default: 0 },

  totalChats: { type: Number, default: 0 },



  // ─── PROFILE SHARING / REFERRAL STATS ──────

  profileShares: { type: Number, default: 0 },

  referralClicks: { type: Number, default: 0 },

  referralBySource: { type: Map, of: Number, default: {} },

  referralSignups: { type: Number, default: 0 },

  lastSharedAt: { type: Date, default: null },

  rating: { type: Number, default: 0, min: 0, max: 5 },

  responseRate: { type: Number, default: 0, min: 0, max: 100 },

  activeQuestions: { type: Number, default: 0, min: 0 },

  successfulMatches: { type: Number, default: 0, min: 0 },



  // ─── FEEDBACK STATS ────────────────────────

  feedbackScore: { type: Number, default: 0, min: 0, max: 1 },

  totalAnswered: { type: Number, default: 0 },

  helpfulCount: { type: Number, default: 0 },

  // Answers that actually received a rating — the correct denominator for

  // feedbackScore. Dividing by totalAnswered punishes mentors for unrated answers.

  feedbackCount: { type: Number, default: 0 },



  // ─── OUTCOME STATS ─────────────────────────

  // Verified results: did students who followed this mentor's advice actually

  // achieve the target (internship/placement/interview)? This is the moat metric.

  outcomeScore: { type: Number, default: 0, min: 0, max: 1 }, // Laplace-smoothed success rate

  outcomeCount: { type: Number, default: 0 },                 // outcomes reported

  outcomeSuccessCount: { type: Number, default: 0 },          // outcomes achieved



  // ─── MENTOR STRATEGY ───────────────────────

  strategy: {

    tone: String,

    language: String,

    hardTruth: [String],

    timeWaste: [String],

    roadmap: [String],

    resumeTip: [String],

    neverRecommend: [String],

    permission: Boolean

  },



  // ─── CREDITS ───────────────────────────────

  messageCredits: { type: Number, default: 5 },

  credits: { type: Number, default: 3, min: 0 },



  // ─── SUBSCRIPTION ───────────────────────────

  subscriptionPlan: {

    type: String,

    enum: ['free', 'clarity', 'pro'],

    default: 'free'

  },

  subscriptionStatus: {

    type: String,

    enum: ['active', 'cancelled', 'expired', 'pending'],

    default: 'active'

  },

  subscriptionExpiry: {

    type: Date,

    default: null

  },

  razorpaySubscriptionId: {

    type: String,

    default: null

  },

  subscriptionCredits: {

    type: Number,

    default: 0

  },



  // ─── PURCHASED TEMPLATES ───────────────────

  purchasedTemplates: [{

    templateId: { type: Number, required: true },

    paymentId: { type: String },

    canvaLink: { type: String },

    expiresAt: { type: Date, required: true },

    createdAt: { type: Date, default: Date.now }

  }],



  // ─── PROFILE STRENGTH ──────────────────────

  profileStrength: { type: Number, min: 0, max: 100, default: 0 },



  // ─── OAUTH & CALENDAR ──────────────────────

  accessToken: {

    type: String,

    select: false

  },



  refreshToken: {

    type: String,

    select: false

  },



  picture: { type: String, default: null },



  calendarConnected: { type: Boolean, default: false },



  calendarProvider: {

    type: String,

    enum: ['google', 'outlook', 'manual', null],

    default: null

  },



  lastLogin: { type: Date, default: null },



}, {

  timestamps: true

});



// ─────────────────────────────────────────────

//  INDEXES

// ─────────────────────────────────────────────

userSchema.index({ 'location.coordinates': '2dsphere' }, { sparse: true });

userSchema.index({ role: 1, lastActive: -1, activeQuestions: 1 });

userSchema.index({ role: 1, topCompanies: 1 });



// ─────────────────────────────────────────────

//  PRE-SAVE HOOKS

// ─────────────────────────────────────────────

userSchema.pre('save', function (next) {

  // Strip invalid location objects

  if (

    this.location &&

    (!this.location.type ||

      !Array.isArray(this.location.coordinates) ||

      this.location.coordinates.length !== 2)

  ) {

    this.location = undefined;

  }



  // Auto-sync institutionName ↔ institution (backward compat)

  if (Array.isArray(this.education)) {

    this.education.forEach(e => {

      if (e.institutionName && !e.institution) e.institution = e.institutionName;

      if (e.institution && !e.institutionName) e.institutionName = e.institution;

    });

  }



  // Recalculate profile strength

  this.profileStrength = this.calculateProfileStrength();

  next();

});



// ─────────────────────────────────────────────

//  METHODS

// ─────────────────────────────────────────────

userSchema.methods.calculateProfileStrength = function () {

  let strength = 0;

  const checks = {

    username: 10,

    bio: 15,

    profilePicture: 10,

    education: 20,

    interests: 15,

    city: 10,

    linkedinProfile: 10,

    expertise: 10

  };



  for (const [field, points] of Object.entries(checks)) {

    if (field === 'education') {

      if (this.education?.length > 0 && (this.education[0].institutionName || this.education[0].institution)) {

        strength += points;

      }

    } else if (field === 'interests') {

      if (this.interests?.length > 0) strength += points;

    } else if (field === 'expertise') {

      if (this.role === 'mentor' && this.expertise?.length > 0) strength += points;

    } else if (this[field]) {

      strength += points;

    }

  }



  return Math.min(100, strength);

};



const User = mongoose.model('User', userSchema);

export default User;