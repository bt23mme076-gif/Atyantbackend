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

  // ─── EMAIL VERIFICATION (NEW) ───────────────
  isEmailVerified: { type: Boolean, index: true },

  emailOTP: {
    type: String,
    select: false,
    default: null
  },

  emailOTPExpires: {
    type: Date,
    select: false,
    default: null
  },
  // ────────────────────────────────────────────

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
    default: null
  },

  // ─── PROFILE ───────────────────────────────
  profilePicture: {
    type: String,
    default: null
  },

  bio: {
    type: String,
    maxlength: 500,
    default: null
  },

  // ─── EDUCATION ─────────────────────────────
  education: [{
    institution: String,
    degree: String,
    field: String,
    startYear: Number,
    endYear: Number,
    current: Boolean
  }],

  // ─── RESET PASSWORD ────────────────────────
  resetOTP: {
    type: String,
    select: false,
    default: null
  },

  resetOTPExpires: {
    type: Date,
    select: false,
    default: null
  },

  // ─── CALENDAR ──────────────────────────────
  calendarConnected: {
    type: Boolean,
    default: false
  },

  calendarProvider: {
    type: String,
    default: null
  },

  accessToken: {
    type: String,
    select: false,
    default: null
  },

  refreshToken: {
    type: String,
    select: false,
    default: null
  },

  // ─── STATS ─────────────────────────────────
  referralSignups: {
    type: Number,
    default: 0
  },

  credits: {
    type: Number,
    default: 0
  },

}, {
  timestamps: true,
});

const User = mongoose.model('User', userSchema);
export default User;