import express from 'express';
import User from '../models/User.js';
import Message from '../models/Message.js';
import { chatMessageLimiter, chatInfoLimiter } from '../middleware/rateLimiters.js';
import { moderator } from '../utils/ContentModerator.js';

const router = express.Router();

// Add error handling middleware
const errorHandler = (err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    error: 'Internal Server Error',
    message: err.message 
  });
};

// Middleware to check message content
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

// Apply content moderation to all routes
router.use(messageContentMiddleware);

// Apply specific rate limiters to different routes
router.use('/messages', chatMessageLimiter); // For sending messages
router.use(['/recent-chats', '/conversations'], chatInfoLimiter); // For fetching chat info

// Get recent chats with last message and unread count
router.get('/recent-chats', async (req, res) => {
  try {
    if (!req.user?._id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get all conversations for the user
    const messages = await Message.aggregate([
      {
        $match: {
          $or: [
            { sender: req.user._id },
            { receiver: req.user._id }
          ]
        }
      },
      {
        $sort: { createdAt: -1 }
      },
      {
        $group: {
          _id: {
            $cond: [
              { $eq: ['$sender', req.user._id] },
              '$receiver',
              '$sender'
            ]
          },
          lastMessage: { $first: '$$ROOT' },
          unreadCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$receiver', req.user._id] },
                    { $ne: ['$status', 'seen'] }
                  ]
                },
                1,
                0
              ]
            }
          }
        }
      }
    ]);

    // Get user details for each conversation
    const conversationsWithUsers = await Promise.all(
      messages.map(async (conv) => {
        const otherUser = await User.findById(conv._id).select('username profilePicture role');
        return {
          user: otherUser,
          lastMessage: conv.lastMessage,
          unreadCount: conv.unreadCount
        };
      })
    );

    res.json(conversationsWithUsers);
  } catch (error) {
    console.error('Error in recent-chats:', error);
    res.status(500).json({ 
      error: 'Failed to fetch recent chats',
      details: error.message
    });
  }
});

// Add retry logic for failed requests
const withRetry = async (operation, maxRetries = 3) => {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (error.status === 429) { // Rate limit error
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // Exponential backoff
        continue;
      }
      throw error;
    }
  }
  throw lastError;
};

// Route to get all mentors
router.get('/mentors', async (req, res) => {
  try {
    const mentors = await User.find({ role: 'mentor' }).select('username email _id profilePicture');
    res.json(mentors);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching mentors.' });
  }
});

// Mentor -> get their list of chats
router.get('/conversations/mentor/:mentorId', async (req, res) => {
  try {
    const { mentorId } = req.params;
    const messages = await Message.find({ $or: [{ sender: mentorId }, { receiver: mentorId }] })
      .populate('sender', 'username _id role profilePicture')  // ADDED profilePicture
      .populate('receiver', 'username _id role profilePicture'); // ADDED profilePicture

    const conversations = {};
    messages.forEach(msg => {
      if (!msg.sender || !msg.receiver) return; // skip broken refs

      const otherUser = String(msg.sender._id) === mentorId ? msg.receiver : msg.sender;
      if (otherUser && otherUser._id) {
        conversations[otherUser._id] = otherUser;
      }
    });

    res.json(Object.values(conversations));
  } catch (error) {
    console.error('Error fetching mentor conversations:', error);
    res.status(500).json({ message: 'Error fetching mentor conversations.' });
  }
});

// User -> get their "My Chats" list
router.get('/conversations/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const messages = await Message.find({ $or: [{ sender: userId }, { receiver: userId }] })
      .populate('sender', 'username _id role profilePicture')  // ADDED profilePicture
      .populate('receiver', 'username _id role profilePicture'); // ADDED profilePicture

    const conversations = {};
    messages.forEach(msg => {
      if (!msg.sender || !msg.receiver) return; // skip broken refs

      const otherUser = String(msg.sender._id) === userId ? msg.receiver : msg.sender;
      if (otherUser && otherUser.role === 'mentor') {
        conversations[otherUser._id] = otherUser;
      }
    });
    
    res.json(Object.values(conversations));
  } catch (error) {
    console.error('Error fetching user conversations:', error);
    res.status(500).json({ message: 'Error fetching user conversations.' });
  }
});

// Get actual messages for a specific chat
router.get('/messages/:userId1/:userId2', async (req, res) => {
  try {
    const { userId1, userId2 } = req.params;
    const { skip = 0, limit = 20 } = req.query;
    
    const messages = await Message.find({
      $or: [
        { sender: userId1, receiver: userId2 },
        { sender: userId2, receiver: userId1 }
      ]
    })
    .populate('sender', 'username _id profilePicture')    // ADDED profilePicture
    .populate('receiver', 'username _id profilePicture')  // ADDED profilePicture
    .sort({ createdAt: -1 })  // Latest first for pagination
    .skip(parseInt(skip))
    .limit(parseInt(limit));

    // Reverse to show oldest first in UI
    const reversedMessages = messages.reverse();
    res.json(reversedMessages);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ message: 'Error fetching messages.' });
  }
});
// DELETE a message by id
router.delete('/messages/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Message.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ message: "Message not found" });
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ message: 'Error deleting message.' });
  }
});
// Get unread message count
router.get('/unread/:userId', async (req, res) => {
  try {
    const count = await Message.countDocuments({
      receiver: req.user._id,
      sender: req.params.userId,
      status: { $ne: 'seen' }
    });
    res.json({ count });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching unread count.' });
  }
});

// Mark messages as seen
router.put('/messages/seen/:senderId', async (req, res) => {
  try {
    await Message.updateMany(
      {
        sender: req.params.senderId,
        receiver: req.user._id,
        status: { $ne: 'seen' }
      },
      { status: 'seen' }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: 'Error updating message status.' });
  }
});

// Get recent conversations with last message and unread count
router.get('/recent-chats', async (req, res) => {
  try {
    const userId = req.user._id;
    
    // Get all conversations where user is involved
    const conversations = await Message.aggregate([
      {
        $match: {
          $or: [
            { sender: userId },
            { receiver: userId }
          ]
        }
      },
      {
        $sort: { createdAt: -1 }
      },
      {
        $group: {
          _id: {
            $cond: [
              { $eq: ['$sender', userId] },
              '$receiver',
              '$sender'
            ]
          },
          lastMessage: { $first: '$$ROOT' },
          unreadCount: {
            $sum: {
              $cond: [
                { 
                  $and: [
                    { $eq: ['$receiver', userId] },
                    { $ne: ['$status', 'seen'] }
                  ]
                },
                1,
                0
              ]
            }
          }
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user'
        }
      },
      {
        $unwind: '$user'
      },
      {
        $project: {
          _id: 1,
          lastMessage: 1,
          unreadCount: 1,
          'user.username': 1,
          'user.profilePicture': 1,
          'user.role': 1
        }
      },
      {
        $sort: { 'lastMessage.createdAt': -1 }
      }
    ]);

    res.json(conversations);
  } catch (error) {
    console.error('Error fetching recent chats:', error);
    res.status(500).json({ message: 'Error fetching recent chats.' });
  }
});

export default router;
