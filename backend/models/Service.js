import mongoose from 'mongoose';

const serviceSchema = new mongoose.Schema({
  mentorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  type: {
    type: String,
    enum: ['video-call', 'audio-call', 'chat', 'answer-card'],
    required: true
  },
  
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },
  
  description: {
    type: String,
    required: true,
    maxlength: 1000
  },
  
  price: {
    type: Number,
    required: true,
    min: 0
  },
  
  // For video/audio calls
  duration: {
    type: Number, // in minutes
    default: 30
  },
  
  // For answer cards
  audioUrl: {
    type: String
  },
  
  isRecommended: {
    type: Boolean,
    default: false
  },
  
  isActive: {
    type: Boolean,
    default: true
  },
  
  totalSales: {
    type: Number,
    default: 0
  },
  
  totalRevenue: {
    type: Number,
    default: 0
  }
  
}, { timestamps: true });

serviceSchema.index({ mentorId: 1, isActive: 1 });
serviceSchema.index({ type: 1, isActive: 1 });

const Service = mongoose.model('Service', serviceSchema);
export default Service;
