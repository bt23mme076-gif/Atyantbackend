import mongoose from 'mongoose';

const meetingSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  description: String,
  startTime: {
    type: Date,
    required: true
  },
  endTime: {
    type: Date,
    required: true
  },
  meetLink: String,
  googleEventId: {
    type: String,
    unique: true,
    sparse: true
  },
  attendees: [{
    email: String
  }],
  status: {
    type: String,
    enum: ['scheduled', 'completed', 'cancelled'],
    default: 'scheduled'
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking'
  },
  manualSetup: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

meetingSchema.pre('save', async function (next) {
  if (this.isNew) {
    try {
      const eventDetails = {
        title: this.title,
        description: this.description,
        startTime: this.startTime,
        endTime: this.endTime,
        attendees: this.attendees.map(attendee => ({ email: attendee.email })),
      };
      const event = await createCalendarEvent(eventDetails);
      this.googleEventId = event.id;
      this.meetLink = event.htmlLink;
    } catch (error) {
      console.error('Error creating calendar event:', error);
      return next(error);
    }
  }
  next();
});

meetingSchema.index({ createdBy: 1, startTime: -1 });
meetingSchema.index({ bookingId: 1 });

export default mongoose.model('Meeting', meetingSchema);