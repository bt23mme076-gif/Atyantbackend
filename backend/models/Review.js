import mongoose from 'mongoose';

const { Schema } = mongoose;

// One store for every kind of feedback, kept apart by `kind`:
//   platform        — "how is Atyant overall?" Anyone can leave it, signed in or not.
//   mock_interview  — after a finished AI mock interview (one per interview).
//   session         — after a mentor session (one per session). The star rating also
//                     lands on Session.review so the mentor's average stays in one place.
export const REVIEW_KINDS = ['platform', 'mock_interview', 'session'];

// Quick tags the UI offers per kind. Anything else is dropped, so stats stay comparable.
export const REVIEW_TAGS = {
  platform: ['Easy to use', 'Found useful answers', 'Mock interviews', 'Jobs', 'Mentor sessions', 'Confusing to use', 'Slow', 'Missing a feature'],
  mock_interview: ['Questions felt real', 'Good follow-ups', 'Useful report', 'Matched the JD', 'Too hard', 'Too easy', 'Audio/video issues'],
  session: ['Helpful advice', 'Understood my situation', 'Started on time', 'Would book again', 'Too short', 'Audio/video issues'],
};

const reviewSchema = new Schema({
  kind:    { type: String, enum: REVIEW_KINDS, required: true, index: true },
  user:    { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },   // null = signed-out visitor
  target:  { type: Schema.Types.ObjectId, default: null },                            // MockInterview or Session id
  rating:  { type: Number, min: 1, max: 5, required: true },
  tags:    [{ type: String }],
  comment: { type: String, maxlength: 1000, default: '' },
  // Where it was left from — page id, and for services the company/role or mentor.
  context: {
    page:    { type: String, maxlength: 60, default: '' },
    label:   { type: String, maxlength: 120, default: '' },
  },
}, { timestamps: true });

// One review per user per interview/session. Platform feedback has no target, so it's excluded.
reviewSchema.index(
  { user: 1, kind: 1, target: 1 },
  { unique: true, partialFilterExpression: { target: { $type: 'objectId' } } },
);

export default mongoose.models.Review || mongoose.model('Review', reviewSchema);
