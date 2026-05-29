import express from 'express';
import { scheduleMeeting, getMeetings, cancelMeeting } from '../controllers/meetingController.js';

const router = express.Router();

// Middleware to check authentication
const isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
};

router.post('/schedule', isAuthenticated, scheduleMeeting);
router.get('/', isAuthenticated, getMeetings);
router.delete('/:id', isAuthenticated, cancelMeeting);

export default router;