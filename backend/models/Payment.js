import mongoose from 'mongoose';

const PaymentSchema = new mongoose.Schema({
  razorpayPaymentId: { 
    type: String, 
    required: true
  },
  questionId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Question',
    required: true
  },
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User',
    required: true
  },
  mentorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  mentorshipType: { 
    type: String, 
    enum: ['chat', 'video', 'roadmap'],
    required: true
  },
  amount: { 
    type: Number, 
    required: true 
  },
  currency: { 
    type: String, 
    default: 'INR' 
  },
  status: { 
    type: String, 
    enum: ['created', 'captured', 'failed', 'refunded'],
    default: 'created'
  },
  razorpayData: {
    type: mongoose.Schema.Types.Mixed
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  }
});

// Indexes for faster queries (removed duplicate index)
PaymentSchema.index({ razorpayPaymentId: 1 }, { unique: true });
PaymentSchema.index({ questionId: 1, status: 1 });
PaymentSchema.index({ userId: 1 });

const Payment = mongoose.model('Payment', PaymentSchema);
export default Payment;
