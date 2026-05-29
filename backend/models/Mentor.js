import mongoose from 'mongoose';

const mentorSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  name: { type: String },
  email: { type: String },
  bio: { type: String },
  expertise: [{ type: String, trim: true }],
  profilePicture: { type: String },
  location: {
    city: String,
    state: String,
    country: String,
    coordinates: {
      lat: Number,
      lon: Number
    }
  },
  ratings: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rating: Number,
    review: String,
    createdAt: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

const Mentor = mongoose.model('Mentor', mentorSchema);

export default Mentor;