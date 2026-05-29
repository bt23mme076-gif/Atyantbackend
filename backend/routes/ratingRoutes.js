import express from 'express';
import {
  getMentorRating,
  getMentorReviews,
  submitRating,
  getTopRatedMentors
} from '../controllers/ratingController.js'; // ✅ Add .js extension
import { protect } from '../middleware/authMiddleware.js'; // ✅ Add .js extension

const router = express.Router();

// ✅ Public routes
router.get('/mentor/:mentorId', getMentorRating);
router.get('/mentor/:mentorId/reviews', getMentorReviews);
router.get('/top-mentors', getTopRatedMentors);

// ✅ Protected routes
router.post('/', protect, submitRating);

export default router; // ✅ Changed from module.exports