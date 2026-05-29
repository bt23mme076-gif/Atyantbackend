// ✅ pushRoutes.js — ES Module syntax
import express from 'express';
import pushController from '../controllers/pushController.js';

const router = express.Router();

// Save push subscription
router.post('/save-subscription', pushController.saveSubscription);

// Send push notification (admin/test)
router.post('/send-notification', pushController.sendNotification);

export default router;  // ← yahi missing tha