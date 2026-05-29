import mongoose from 'mongoose';

const aiConversationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  messages: [{
    role: {
      type: String,
      enum: ['user', 'assistant'],
      required: true
    },
    content: {
      type: String,
      required: true
    },
    timestamp: {
      type: Date,
      default: Date.now
    }
  }],
  context: {
    currentTopic: {
      type: String,
      default: 'general'
    },
    suggestedMentors: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }]
  },
  metadata: {
    totalMessages: { 
      type: Number, 
      default: 0 
    },
    lastActive: { 
      type: Date, 
      default: Date.now 
    }
  }
}, { 
  timestamps: true 
});

// Index for faster queries
aiConversationSchema.index({ userId: 1, 'metadata.lastActive': -1 });

export default mongoose.model('AIConversation', aiConversationSchema);