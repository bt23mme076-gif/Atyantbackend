import express from 'express';
import mongoose from 'mongoose';
import Message from '../models/Message.js';
import User from '../models/User.js';
import Session from '../models/Session.js';
import protect from '../middleware/authMiddleware.js';
import { getChatEntitlement } from '../utils/chatEntitlement.js';

const router = express.Router();

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);
const oid = (id) => new mongoose.Types.ObjectId(String(id));

// Build the conversation list for `userId` with last message, unread count and
// newest-first ordering — all in a single aggregation (WhatsApp-style sidebar).
async function buildConversations(userId) {
  const uid = oid(userId);
  const rows = await Message.aggregate([
    { $match: { $or: [{ sender: uid }, { receiver: uid }] } },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: { $cond: [{ $eq: ['$sender', uid] }, '$receiver', '$sender'] },
        lastMessage:   { $first: '$text' },
        lastMessageAt: { $first: '$createdAt' },
        lastSender:    { $first: '$sender' },
        unreadCount: {
          $sum: {
            $cond: [{ $and: [{ $eq: ['$receiver', uid] }, { $ne: ['$seen', true] }] }, 1, 0],
          },
        },
      },
    },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
    { $unwind: '$user' },
    { $sort: { lastMessageAt: -1 } },
    {
      $project: {
        _id: '$user._id',
        username: '$user.username',
        name: '$user.name',
        profilePicture: '$user.profilePicture',
        role: '$user.role',
        lastMessage: 1,
        lastMessageAt: 1,
        lastSenderIsMe: { $eq: ['$lastSender', uid] },
        unreadCount: 1,
      },
    },
  ]);
  return rows;
}

// ── Mentor → their list of chats ─────────────────────────────────────────────
router.get('/conversations/mentor/:mentorId', protect, async (req, res) => {
  try {
    const { mentorId } = req.params;
    if (!isValidId(mentorId)) return res.status(400).json({ message: 'Invalid id' });
    if (String(req.user.userId) !== String(mentorId)) return res.status(403).json({ message: 'Forbidden' });

    const conversations = await buildConversations(mentorId);
    res.json(conversations);
  } catch (error) {
    console.error('mentor conversations error:', error);
    res.status(500).json({ message: 'Error fetching mentor conversations.' });
  }
});

// ── User → their "My Mentors" chat list (only mentors) ───────────────────────
router.get('/conversations/user/:userId', protect, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!isValidId(userId)) return res.status(400).json({ message: 'Invalid id' });
    if (String(req.user.userId) !== String(userId)) return res.status(403).json({ message: 'Forbidden' });

    const conversations = await buildConversations(userId);
    res.json(conversations.filter((c) => c.role === 'mentor'));
  } catch (error) {
    console.error('user conversations error:', error);
    res.status(500).json({ message: 'Error fetching user conversations.' });
  }
});

// ── Paginated message thread between two users ────────────────────────────────
router.get('/messages/:userId1/:userId2', protect, async (req, res) => {
  try {
    const { userId1, userId2 } = req.params;
    if (!isValidId(userId1) || !isValidId(userId2)) return res.status(400).json({ message: 'Invalid id' });
    // Only a participant may read the thread.
    if (![String(userId1), String(userId2)].includes(String(req.user.userId))) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    const skip = parseInt(req.query.skip, 10) || 0;
    const limit = parseInt(req.query.limit, 10) || 20;

    const messages = await Message.find({
      $or: [
        { sender: userId1, receiver: userId2 },
        { sender: userId2, receiver: userId1 },
      ],
    })
      .populate('sender', 'username name _id profilePicture')
      .populate('receiver', 'username name _id profilePicture')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json(messages.reverse()); // oldest-first for the UI
  } catch (error) {
    console.error('fetch messages error:', error);
    res.status(500).json({ message: 'Error fetching messages.' });
  }
});

// ── Mark every message from `partnerId` → me as read (bulk; sidebar badge) ────
router.post('/messages/read/:partnerId', protect, async (req, res) => {
  try {
    const { partnerId } = req.params;
    if (!isValidId(partnerId)) return res.status(400).json({ message: 'Invalid id' });
    const me = req.user.userId;

    const result = await Message.updateMany(
      { sender: partnerId, receiver: me, seen: { $ne: true } },
      { $set: { seen: true, status: 'read', readAt: new Date() } },
    );

    // Let the OTHER side update their delivery ticks live, if they're online.
    const io = req.app.get('io');
    if (io && result.modifiedCount > 0) {
      io.to(String(partnerId)).emit('messages_read_bulk', { reader: String(me) });
    }
    res.json({ success: true, modified: result.modifiedCount });
  } catch (error) {
    console.error('bulk read error:', error);
    res.status(500).json({ message: 'Error marking messages read.' });
  }
});

// ── Delete a single message (sender only) ────────────────────────────────────
router.delete('/messages/:id', protect, async (req, res) => {
  try {
    const msg = await Message.findById(req.params.id);
    if (!msg) return res.status(404).json({ message: 'Message not found' });
    if (String(msg.sender) !== String(req.user.userId)) {
      return res.status(403).json({ message: 'You can only delete your own messages' });
    }
    await Message.deleteOne({ _id: msg._id });
    const io = req.app.get('io');
    if (io) {
      io.to(String(msg.sender)).emit('message_deleted', { messageId: String(msg._id) });
      if (msg.receiver) io.to(String(msg.receiver)).emit('message_deleted', { messageId: String(msg._id) });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('delete message error:', error);
    res.status(500).json({ message: 'Error deleting message.' });
  }
});

// ── Chat entitlement: does the logged-in STUDENT hold an active Text Q&A
//    purchase with :mentorId?  Drives the unlock card + input enable/disable. ──
router.get('/chat/entitlement/:mentorId', protect, async (req, res) => {
  try {
    const { mentorId } = req.params;
    if (!isValidId(mentorId)) return res.status(400).json({ message: 'Invalid id' });

    // Mentors are never gated when replying to their own students.
    if (req.user.role === 'mentor') {
      return res.json({ allowed: true, role: 'mentor', expiresAt: null, expired: false });
    }

    const ent = await getChatEntitlement(req.user.userId, mentorId);
    res.json({
      allowed: ent.allowed,
      expired: ent.expired,
      expiresAt: ent.expiresAt,
      serviceLabel: ent.serviceLabel,
      resolved: ent.session?.chatResolved || false,
    });
  } catch (error) {
    console.error('entitlement error:', error);
    res.status(500).json({ message: 'Error checking entitlement.' });
  }
});

// ── Mentor marks a student's Text Q&A conversation resolved ───────────────────
router.post('/chat/resolve/:studentId', protect, async (req, res) => {
  try {
    if (req.user.role !== 'mentor') return res.status(403).json({ message: 'Only mentors can resolve chats' });
    const { studentId } = req.params;
    if (!isValidId(studentId)) return res.status(400).json({ message: 'Invalid id' });

    const session = await Session.findOneAndUpdate(
      { mentorId: req.user.userId, userId: studentId, serviceId: 'text-qa', paymentStatus: { $in: ['paid', 'free'] } },
      { $set: { chatResolved: true, chatResolvedAt: new Date() } },
      { sort: { scheduledAt: -1 }, new: true },
    );
    if (!session) return res.status(404).json({ message: 'No Text Q&A session found for this student' });

    const io = req.app.get('io');
    if (io) io.to(String(studentId)).emit('chat_resolved', { mentorId: String(req.user.userId) });
    res.json({ success: true });
  } catch (error) {
    console.error('resolve chat error:', error);
    res.status(500).json({ message: 'Error resolving chat.' });
  }
});

// ── Lookup a single user/mentor (for "Talk to Senior" auto-open) ─────────────
router.get('/users/:id', protect, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ message: 'Invalid id' });
    const user = await User.findById(id)
      .select('username name profilePicture role bio education')
      .lean();
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user);
  } catch (error) {
    console.error('fetch user error:', error);
    res.status(500).json({ message: 'Error fetching user.' });
  }
});

export default router;
