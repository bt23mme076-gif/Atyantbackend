import mongoose from 'mongoose';

const mentorExperienceSchema = new mongoose.Schema({

  questionId: {
    type    : mongoose.Schema.Types.ObjectId,
    ref     : 'Question',
    required: true,
    index   : true
  },

  mentorId: {
    type    : mongoose.Schema.Types.ObjectId,
    ref     : 'User',
    required: true,
    index   : true
  },

  rawExperience: {
    situation    : { type: String, required: true, maxlength: 1000 },
    firstAttempt : { type: String, required: true, maxlength: 1000 },
    // 🔴 FIX: Typed arrays instead of bare Array
    keyMistakes  : [{ type: String }],
    whatWorked   : { type: String, required: true, maxlength: 1000 },
    actionableSteps: [{
      step       : { type: String },
      description: { type: String }
    }],
    timeline         : { type: String, required: true, maxlength: 500 },
    differentApproach: { type: String, required: true, maxlength: 1000 },
    additionalNotes  : { type: String, maxlength: 500, default: '' }
  },

  status: {
    type   : String,
    enum   : ['draft', 'submitted', 'processed'],
    default: 'draft'
  },

  submittedAt: { type: Date, default: null }

}, {
  // 🔴 FIX: Use built-in timestamps
  timestamps: true
});

// Auto-set submittedAt when status becomes 'submitted'
mentorExperienceSchema.pre('save', function (next) {
  if (this.isModified('status') && this.status === 'submitted' && !this.submittedAt) {
    this.submittedAt = new Date();
  }
  next();
});

const MentorExperience = mongoose.model('MentorExperience', mentorExperienceSchema);
export default MentorExperience;
