import mongoose from 'mongoose';

const FeedbackSchema = new mongoose.Schema({
  name: { type: String, default: "Anonymous" }, // optional
  email: { type: String, default: "" },         // optional
  rating: { type: Number, required: true, min: 1, max: 5 },
  feedback: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const Feedback = mongoose.model('Feedback', FeedbackSchema);

export default Feedback;
