import express from 'express';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import cloudinary from '../config/cloudinary.js';
import protect from '../middleware/authMiddleware.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// ─────────────────────────────────────────────
//  GET /me  — current user profile
//  🔴 FIX: includes credits so frontend stays in sync
// ─────────────────────────────────────────────
router.get('/me', protect, async (req, res) => {
  try {
    const userId = req.user.userId;

    const user = await User.findById(userId)
      .select('-password -verificationToken -passwordResetToken -passwordResetExpires')
      .lean();

    if (!user) return res.status(404).json({ message: 'User not found' });

    const hasLocation = !!(user.location?.coordinates?.length === 2);

    res.json({ ...user, hasLocation });
  } catch (error) {
    console.error('GET /profile/me error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ─────────────────────────────────────────────
//  🔴 NEW: GET /me/credits — lightweight credit check
//  Frontend calls this after payment to refresh credits
//  without fetching entire profile
// ─────────────────────────────────────────────
router.get('/me/credits', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId)
      .select('messageCredits credits')
      .lean();

    if (!user) return res.status(404).json({ message: 'User not found' });

    res.json({
      success       : true,
      messageCredits: user.messageCredits ?? 0,
      credits       : user.credits ?? 0
    });
  } catch (error) {
    console.error('GET /profile/me/credits error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─────────────────────────────────────────────
//  PUT /me  — update profile
// ─────────────────────────────────────────────
router.put('/me', protect, async (req, res) => {
  try {
    const userId    = req.user.userId;
    const updateData = req.body;

    // Security: prevent clients from directly setting credit balances.
    // Credits are managed server-side (payments, admin actions).
    if (updateData && typeof updateData === 'object') {
      delete updateData.credits;
      delete updateData.messageCredits;
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Basic scalar fields
    const basicFields = ['username', 'bio', 'city', 'linkedinProfile'];
    basicFields.forEach(field => {
      if (updateData[field] !== undefined) user[field] = updateData[field];
    });

    // Strategy (deep merge)
    if (updateData.strategy && typeof updateData.strategy === 'object') {
      user.strategy = { ...(user.strategy?.toObject?.() || user.strategy || {}), ...updateData.strategy };
      user.markModified('strategy');
    }

    // Enums — 🔴 FIX: empty string → null (prevents Mongoose enum validation error)
    const enumFields = {
      companyDomain : ['Tech', 'Data Analytics', 'Consulting', 'Product', 'Core Engineering'],
      primaryDomain : ['placement', 'internship', 'both']
    };
    for (const [field, allowed] of Object.entries(enumFields)) {
      if (updateData[field] === '' || updateData[field] === null) {
        user[field] = null;
      } else if (updateData[field] && allowed.includes(updateData[field])) {
        user[field] = updateData[field];
      }
    }

    // Array fields
    const arrayFields = ['interests', 'expertise', 'domainExperience', 'skills', 'topCompanies', 'milestones', 'specialTags'];
    arrayFields.forEach(field => {
      if (updateData[field] !== undefined) {
        user[field] = Array.isArray(updateData[field]) ? updateData[field] : [];
      }
    });

    // Education — 🔴 FIX: sync both institution & institutionName for AtyantEngine
    if (updateData.education !== undefined) {
      user.education = Array.isArray(updateData.education)
        ? updateData.education
            .filter(e => e.institution || e.institutionName)
            .map(e => ({
              institution    : e.institution || e.institutionName || '',
              institutionName: e.institutionName || e.institution || '',
              degree         : e.degree || '',
              field          : e.field  || '',
              year           : e.year   || '',
              cgpa           : e.cgpa ? Number(e.cgpa) : undefined
            }))
        : [];
    }

    await user.save();

    const userResponse = user.toObject();
    delete userResponse.password;
    delete userResponse.verificationToken;
    delete userResponse.passwordResetToken;
    delete userResponse.passwordResetExpires;

    res.json({ message: 'Profile updated', user: userResponse });
  } catch (error) {
    console.error('PUT /profile/me error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ─────────────────────────────────────────────
//  POST /upload-picture
// ─────────────────────────────────────────────
router.post('/upload-picture', protect, upload.single('profilePicture'), async (req, res) => {
  try {
    const userId = req.user.userId;

    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'atyant_profiles' },
        (error, result) => error ? reject(error) : resolve(result)
      );
      stream.end(req.file.buffer);
    });

    user.profilePicture = result.secure_url;
    await user.save();

    res.json({ message: 'Profile picture updated', profilePicture: user.profilePicture });
  } catch (error) {
    console.error('POST /upload-picture error:', error);
    res.status(500).json({ message: 'Upload failed', error: error.message });
  }
});

// ─────────────────────────────────────────────
//  POST /parse-linkedin  — Extract Profile Data
// ─────────────────────────────────────────────
router.post('/parse-linkedin', protect, upload.single('resumePdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    // 1. Convert PDF to Text
    const pdfData = await pdfParse(req.file.buffer);
    const resumeText = pdfData.text;

    if (!resumeText || resumeText.length < 50) {
      return res.status(400).json({ message: 'Could not read text from PDF.' });
    }

    // 2. Call Gemini API to extract data
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `
      You are an expert resume parser. Extract profile details from the text below.
      Format the output ONLY as a strict JSON object matching this schema exactly:
      {
        "bio": "A precise 2-sentence professional summary",
        "city": "Extracted City Name (e.g. Pune, Bangalore, Delhi)",
        "topCompanies": ["Company1", "Company2"],
        "expertise": ["Skill1", "Skill2", "Skill3"],
        "education": [
          {
            "institution": "Full College Name", 
            "degree": "Clean Degree Name (e.g. B.Tech, Master's)", 
            "year": "Graduation Year (YYYY)", 
            "field": "Branch/Major (e.g. Computer Science)"
          }
        ]
      }
      
      RULES:
      - Return ONLY raw JSON, NO markdown wrapping (no \`\`\`json).
      - If a field is not found, leave it empty.
      
      RESUME TEXT:
      ${resumeText.substring(0, 8000)}
    `;

    const result = await model.generateContent(prompt);
    let cleanJson = result.response.text();
    // Strip markdown formatting if AI accidentally adds it
    cleanJson = cleanJson.replace(/```json/g, '').replace(/```/g, '').trim();

    const parsedData = JSON.parse(cleanJson);
    res.json({ success: true, data: parsedData });
  } catch (error) {
    console.error('POST /parse-linkedin error:', error);
    res.status(500).json({ message: 'Failed to process resume', error: error.message });
  }
});

// ─────────────────────────────────────────────
//  GET /:username  — public profile
// ─────────────────────────────────────────────
router.get('/:username', async (req, res) => {
  try {
    const user = await User.findOne({
      username: new RegExp(`^${req.params.username}$`, 'i')
    })
      .select('-password -verificationToken -passwordResetToken -passwordResetExpires -messageCredits -credits')
      .lean();

    if (!user) return res.status(404).json({ message: 'User not found' });

    // Count profile view — only if viewer ≠ mentor, non-blocking
    if (user.role === 'mentor') {
      const authHeader = req.headers.authorization;
      let viewerId = null;
      if (authHeader?.startsWith('Bearer ')) {
        try {
          const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
          viewerId = decoded._id || decoded.id || decoded.userId;
        } catch { /* invalid token — ignore */ }
      }
      if (viewerId && viewerId !== user._id.toString()) {
        User.findByIdAndUpdate(user._id, { $inc: { profileViews: 1 } })
          .catch(err => console.error('profileViews increment error:', err.message));
      }
    }

    res.json(user);
  } catch (error) {
    console.error('GET /profile/:username error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

export default router;
