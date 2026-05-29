import mongoose from 'mongoose';

const ratingSchema = new mongoose.Schema(
  {
    mentor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    chatSession: {
      type: String, // ✅ CHANGED from ObjectId to String
      required: true,
      index: true // ✅ Add index for faster queries
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5
    },
    feedbackText: {
      type: String,
      trim: true,
      maxlength: 500
    },
    isPublic: {
      type: Boolean,
      default: true
    }
  },
  {
    timestamps: true
  }
);

// ✅ UPDATED: Compound index for unique ratings per chat session
ratingSchema.index({ user: 1, chatSession: 1 }, { unique: true });

// ✅ Index for mentor rating queries
ratingSchema.index({ mentor: 1, isPublic: 1 });

export default mongoose.model('Rating', ratingSchema);