import User from '../models/User.js';

// Records a student's review on a session and folds the rating into the mentor's
// rolling average. Shared by POST /api/sessions/:id/review and POST /api/reviews
// (kind "session") so the mentor rating is only ever updated in one place.
// Caller checks ownership and "not already reviewed" first.
export async function applySessionReview(session, rating, comment = '') {
  session.review = {
    rating,
    comment: String(comment || '').trim().slice(0, 300),
    submittedAt: new Date(),
  };
  await session.save();

  if (session.mentorId) {
    const mentor = await User.findById(session.mentorId);
    if (mentor) {
      const prev = mentor.feedbackCount || 0;
      mentor.rating = ((mentor.rating || 0) * prev + rating) / (prev + 1);
      mentor.feedbackCount = prev + 1;
      mentor.successfulMatches = (mentor.successfulMatches || 0) + 1;
      await mentor.save();
    }
  }
}
