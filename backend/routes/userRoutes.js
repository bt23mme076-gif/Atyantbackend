import express from 'express';
import User from '../models/User.js';
import auth from '../middleware/auth.js';
import multer from 'multer';
import path from 'path';
import jwt from 'jsonwebtoken'; // ✅ ADD THIS

const router = express.Router();

// Multer config
const upload = multer({
  dest: 'uploads/profiles/',
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
});

// ✅ NEW: Get user by ID (for fetching profile in chat)
router.get('/:id', auth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('username name email profilePicture bio role');
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    console.log('✅ User fetched for chat:', user.username);
    
    res.json({
      _id: user._id,
      id: user._id,
      userId: user._id,
      username: user.username,
      name: user.name || user.username,
      email: user.email,
      profilePicture: user.profilePicture,
      bio: user.bio,
      role: user.role
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ✅ UPDATE THIS ROUTE
router.post('/upload-profile-picture', auth, upload.single('profilePicture'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const profilePictureUrl = `${process.env.BACKEND_URL || 'http://localhost:5000'}/uploads/profiles/${req.file.filename}`;

    // Update user in database
    await User.findByIdAndUpdate(req.user.userId, {
      profilePicture: profilePictureUrl,
    });

    console.log('✅ Profile picture updated:', profilePictureUrl);

    // ✅ GENERATE NEW TOKEN WITH PROFILE PICTURE
    const updatedUser = await User.findById(req.user.userId);
    
    const newToken = jwt.sign(
      {
        userId: updatedUser._id,
        role: updatedUser.role,
        username: updatedUser.username,
        name: updatedUser.name,
        email: updatedUser.email,
        profilePicture: updatedUser.profilePicture, // ✅ ADD THIS
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Profile picture updated successfully',
      profilePicture: profilePictureUrl,
      token: newToken, // ✅ SEND NEW TOKEN
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ message: 'Failed to upload profile picture' });
  }
});

export default router;