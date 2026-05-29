import express from 'express';
import Message from '../models/Message.js';
import User from '../models/User.js';
import { chatMessageLimiter, chatInfoLimiter } from '../middleware/rateLimiters.js';
import { moderator } from '../utils/ContentModerator.js';
import auth from '../middleware/auth.js';

const router = express.Router();

// Middleware to check message content (only for POST requests)
const messageContentMiddleware = (req, res, next) => {
    const messageText = req.body.text || req.body.content || req.body.message;
    
    if (messageText) {
        const validationResult = moderator.validateMessage(messageText);
        if (!validationResult.isValid) {
            return res.status(400).json({
                success: false,
                message: validationResult.reason
            });
        }
        // Clean the message text
        req.body.text = moderator.clean(messageText);
    }
    next();
};

// Get community chat messages (PUBLIC - no auth required for viewing)
router.get('/messages', chatInfoLimiter, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;

    const messages = await Message.find({ 
      conversationId: 'community-chat' // Special ID for community chat
    })
      .sort({ createdAt: -1 })
      .limit(Math.min(limit, 100)) // Cap at 100 max
      .select('+isAnonymous') // Explicitly include isAnonymous field
      .populate('sender', 'name username email profilePicture role')
      .lean();

    // Reverse to show oldest first
    res.json(messages.reverse());
  } catch (error) {
    console.error('❌ Error fetching community messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Send a message to community chat (PROTECTED - requires auth)
router.post('/send', auth, chatMessageLimiter, messageContentMiddleware, async (req, res) => {
  try {
    if (!req.user?._id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { text, isAnonymous } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Message text is required' });
    }

    const newMessage = new Message({
      conversationId: 'community-chat',
      sender: req.user._id,
      text: text.trim(),
      isAnonymous: Boolean(isAnonymous),
      createdAt: new Date()
    });

    await newMessage.save();

    // Populate sender details
    await newMessage.populate('sender', 'name username email profilePicture role');
    
    // Convert to plain object to ensure all fields are included
    const messageObj = newMessage.toObject();
    
    res.json({ success: true, message: messageObj });
  } catch (error) {
    console.error('❌ Error sending community message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Get online users (PUBLIC - users who sent messages in last 10 minutes)
router.get('/online-users', chatInfoLimiter, async (req, res) => {
  try {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

    // Find unique users who sent messages recently
    const recentSenders = await Message.find({
      conversationId: 'community-chat',
      createdAt: { $gte: tenMinutesAgo }
    })
      .distinct('sender');

    // Get user details
    const onlineUsers = await User.find({
      _id: { $in: recentSenders }
    })
      .select('name username email profilePicture role')
      .lean();

    res.json(onlineUsers);
  } catch (error) {
    console.error('❌ Error fetching online users:', error);
    res.status(500).json({ error: 'Failed to fetch online users' });
  }
});

// Delete a message (PROTECTED - only own messages)
router.delete('/delete/:messageId', auth, async (req, res) => {
  try {
    if (!req.user?._id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { messageId } = req.params;

    // Find the message
    const message = await Message.findOne({
      _id: messageId,
      conversationId: 'community-chat'
    });

    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Check if user is the sender
    if (message.sender.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'You can only delete your own messages' });
    }

    // Delete the message
    await Message.findByIdAndDelete(messageId);

    res.json({ success: true, message: 'Message deleted successfully' });
  } catch (error) {
    console.error('❌ Error deleting message:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

export default router;
