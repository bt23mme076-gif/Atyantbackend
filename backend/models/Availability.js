import mongoose from 'mongoose';

const availabilitySchema = new mongoose.Schema({
  mentorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true
  },
  
  timezone: {
    type: String,
    default: 'Asia/Kolkata'
  },
  
  weeklySchedule: {
    monday: {
      enabled: { type: Boolean, default: false },
      slots: [{ start: String, end: String }]
    },
    tuesday: {
      enabled: { type: Boolean, default: false },
      slots: [{ start: String, end: String }]
    },
    wednesday: {
      enabled: { type: Boolean, default: false },
      slots: [{ start: String, end: String }]
    },
    thursday: {
      enabled: { type: Boolean, default: false },
      slots: [{ start: String, end: String }]
    },
    friday: {
      enabled: { type: Boolean, default: false },
      slots: [{ start: String, end: String }]
    },
    saturday: {
      enabled: { type: Boolean, default: false },
      slots: [{ start: String, end: String }]
    },
    sunday: {
      enabled: { type: Boolean, default: false },
      slots: [{ start: String, end: String }]
    }
  },
  
  blockedDates: [{
    date: { type: Date, required: true },
    reason: { type: String }
  }],
  
  bufferTime: {
    type: Number, // minutes between sessions
    default: 15
  }
  
}, { timestamps: true });

const Availability = mongoose.model('Availability', availabilitySchema);
export default Availability;
