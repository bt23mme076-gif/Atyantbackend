import Message from '../models/Message.js';
import User from '../models/User.js';

// ✅ AI Auto-Reply Template
const generateAutoReply = (mentorName) => {
  return `Hi! This is an automated message from ${mentorName}.
I'm here to help you with your question. Please share your query in detail so I can guide you in the best way possible.
If I'm unable to reply within 48 hours, feel free to reach out again or connect with another mentor — we're here to support you.
Thank you for your patience! 🙏`;
};

// ✅ Check if auto-reply should be sent (FIXED - Only first message)
const shouldSendAutoReply = async (senderId, receiverId) => {
  try {
    console.log('🔍 Checking if auto-reply should be sent...');
    console.log('Sender (user):', senderId);
    console.log('Receiver (mentor):', receiverId);

    // ✅ Check if there's ANY previous message in this conversation
    const previousMessages = await Message.countDocuments({
      $or: [
        { sender: senderId, receiver: receiverId },
        { sender: receiverId, receiver: senderId }
      ]
    });

    console.log('Previous messages in conversation:', previousMessages);

    // ✅ Only send auto-reply if this is the FIRST message (count = 1, the one we just saved)
    if (previousMessages > 1) {
      console.log('⚠️ Not first message, skipping auto-reply');
      return false;
    }

    // ✅ Check if mentor has already sent an auto-reply
    const existingAutoReply = await Message.findOne({
      sender: receiverId,
      receiver: senderId,
      isAutoReply: true
    });

    if (existingAutoReply) {
      console.log('⚠️ Auto-reply already sent previously');
      return false;
    }

    console.log('✅ This is the first message, will send auto-reply');
    return true;

  } catch (error) {
    console.error('❌ Error checking auto-reply condition:', error);
    return false;
  }
};

// ✅ Send auto-reply (FIXED - Real-time without refresh)
export const sendAutoReply = async (io, senderId, receiverId, mentorData) => {
  try {
    console.log('🤖 sendAutoReply called');
    console.log('Sender:', senderId);
    console.log('Receiver (mentor):', receiverId);
    console.log('Mentor data:', mentorData);

    const shouldSend = await shouldSendAutoReply(senderId, receiverId);
    
    if (!shouldSend) {
      console.log('⚠️ Auto-reply conditions not met');
      return null;
    }

    console.log('✅ Creating auto-reply message...');

    const autoReplyMessage = new Message({
      sender: receiverId, // mentor
      receiver: senderId, // user
      text: generateAutoReply(mentorData.username || 'your mentor'),
      timestamp: new Date(),
      isAutoReply: true,
      seen: false,
      status: 'sent'
    });

    await autoReplyMessage.save();
    console.log('✅ Auto-reply saved to database:', autoReplyMessage._id);

    // Populate sender and receiver details
    const populatedMessage = await Message.findById(autoReplyMessage._id)
      .populate('sender', 'username name profilePicture')
      .populate('receiver', 'username name profilePicture');

    console.log('✅ Auto-reply populated:', populatedMessage);

    // ✅ Format message for frontend (matching your message format)
    const messageForFrontend = {
      _id: populatedMessage._id,
      sender: populatedMessage.sender._id,
      senderName: populatedMessage.sender.username || populatedMessage.sender.name,
      senderAvatar: populatedMessage.sender.profilePicture,
      receiver: populatedMessage.receiver._id,
      receiverName: populatedMessage.receiver.username || populatedMessage.receiver.name,
      receiverAvatar: populatedMessage.receiver.profilePicture,
      text: populatedMessage.text,
      createdAt: populatedMessage.createdAt,
      timestamp: populatedMessage.timestamp,
      isAutoReply: true, // ✅ Important flag
      seen: false,
      status: 'sent',
      deliveredAt: null,
      readAt: null
    };

    // ✅ Emit to BOTH users via socket (real-time, no refresh needed)
    io.to(senderId).emit('receive_private_message', messageForFrontend);
    io.to(receiverId).emit('receive_private_message', messageForFrontend);

    console.log('✅ Auto-reply emitted to both users');
    console.log('Emitted to sender (user):', senderId);
    console.log('Emitted to receiver (mentor):', receiverId);

    return populatedMessage;
  } catch (error) {
    console.error('❌ Error sending auto-reply:', error);
    return null;
  }
};