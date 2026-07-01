import express from 'express';
import mongoose from 'mongoose';
import Message from '../models/Message.js';
import User from '../models/User.js';

const router = express.Router();

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

// ── Mentor → their list of chats ────────────────────────────────────────────
router.get('/conversations/mentor/:mentorId', async (req, res) => {
  try {
    const { mentorId } = req.params;
    if (!isValidId(mentorId)) return res.status(400).json({ message: 'Invalid id' });

    const messages = await Message.find({ $or: [{ sender: mentorId }, { receiver: mentorId }] })
      .populate('sender', 'username name _id role profilePicture')
      .populate('receiver', 'username name _id role profilePicture')
      .lean();

    const conversations = {};
    messages.forEach(msg => {
      if (!msg.sender || !msg.receiver) return;
      const otherUser = String(msg.sender._id) === mentorId ? msg.receiver : msg.sender;
      if (otherUser?._id) conversations[otherUser._id] = otherUser;
    });
    res.json(Object.values(conversations));
  } catch (error) {
    console.error('mentor conversations error:', error);
    res.status(500).json({ message: 'Error fetching mentor conversations.' });
  }
});

// ── User → their "My Mentors" chat list (only mentors) ──────────────────────
router.get('/conversations/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!isValidId(userId)) return res.status(400).json({ message: 'Invalid id' });

    const messages = await Message.find({ $or: [{ sender: userId }, { receiver: userId }] })
      .populate('sender', 'username name _id role profilePicture')
      .populate('receiver', 'username name _id role profilePicture')
      .lean();

    const conversations = {};
    messages.forEach(msg => {
      if (!msg.sender || !msg.receiver) return;
      const otherUser = String(msg.sender._id) === userId ? msg.receiver : msg.sender;
      if (otherUser?.role === 'mentor') conversations[otherUser._id] = otherUser;
    });
    res.json(Object.values(conversations));
  } catch (error) {
    console.error('user conversations error:', error);
    res.status(500).json({ message: 'Error fetching user conversations.' });
  }
});

// ── Paginated message thread between two users ──────────────────────────────
router.get('/messages/:userId1/:userId2', async (req, res) => {
  try {
    const { userId1, userId2 } = req.params;
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

// ── Delete a single message ─────────────────────────────────────────────────
router.delete('/messages/:id', async (req, res) => {
  try {
    const deleted = await Message.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Message not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('delete message error:', error);
    res.status(500).json({ message: 'Error deleting message.' });
  }
});

// ── Lookup a single user/mentor (for "Talk to Senior" auto-open) ────────────
router.get('/users/:id', async (req, res) => {
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
