import PushSubscription from '../models/PushSubscription.js';
import webpush from 'web-push';

// Set your VAPID keys here (generate using web-push generate-vapid-keys)
const VAPID_PUBLIC_KEY = 'BOGOV5c557YGqPQJ5fhqi9e_h6H93fw2fBOI-5hEyHmH_2ZuzpIL2McnXMmwgJi4b-IaFBDqVd0qMnjnqsE8bK8';
const VAPID_PRIVATE_KEY = '7YojcrN07u1uwq8PVhwq19PFBk9NXWES862ONVEZEGs';

webpush.setVapidDetails(
  'mailto:admin@atyant.in',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

export const saveSubscription = async (req, res) => {
  try {
    const sub = req.body;
    // Upsert by endpoint
    const saved = await PushSubscription.findOneAndUpdate(
      { endpoint: sub.endpoint },
      sub,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.status(201).json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const sendNotification = async (req, res) => {
  try {
    const { title, body, userId } = req.body;
    let query = {};
    if (userId) query.user = userId;
    const subs = await PushSubscription.find(query);
    const payload = JSON.stringify({ title, body });
    let results = [];
    for (const sub of subs) {
      try {
        await webpush.sendNotification(sub, payload);
        results.push({ endpoint: sub.endpoint, success: true });
      } catch (err) {
        results.push({ endpoint: sub.endpoint, success: false, error: err.message });
      }
    }
    res.json({ sent: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export default { saveSubscription, sendNotification };
