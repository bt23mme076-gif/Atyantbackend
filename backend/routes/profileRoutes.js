import express from 'express';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import cloudinary from '../config/cloudinary.js';
import protect from '../middleware/authMiddleware.js';
import { callGroqJSON } from '../utils/groqJSON.js';
import { SERVICE_CATALOG, sanitizeServiceIds } from '../config/serviceCatalog.js';
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
//  GET /services-catalog — public platform service catalog
//  (labels + platform-fixed prices). Registered before /:username.
// ─────────────────────────────────────────────
router.get('/services-catalog', (req, res) => {
  res.json({ ok: true, services: SERVICE_CATALOG });
});

// ─────────────────────────────────────────────
//  PUT /phone — set the logged-in user's mobile number.
//  Used by the mandatory phone step after Google sign-up (Google's token has
//  no phone). Validates the 10-digit Indian format and enforces uniqueness.
// ─────────────────────────────────────────────
router.put('/phone', protect, async (req, res) => {
  try {
    const phone = String(req.body.phone || '').replace(/\D/g, '').slice(-10);
    if (!/^[6-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ message: 'Enter a valid 10-digit Indian mobile number' });
    }
    // No one else can already own this number.
    const clash = await User.findOne({ phone, _id: { $ne: req.user.userId } }).select('_id').lean();
    if (clash) return res.status(409).json({ message: 'This mobile number is already registered' });

    const user = await User.findByIdAndUpdate(req.user.userId, { phone }, { new: true })
      .select('-password -verificationToken -passwordResetToken -passwordResetExpires');
    if (!user) return res.status(404).json({ message: 'User not found' });

    res.json({ message: 'Mobile number saved', user });
  } catch (err) {
    console.error('PUT /profile/phone error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────
//  GET /by-id/:id — public profile by MongoDB _id
//  Used by BookingPage to get the full profile (incl. servicesOffered)
//  when the mentor object in state only has partial data.
// ─────────────────────────────────────────────
router.get('/by-id/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-password -verificationToken -passwordResetToken -passwordResetExpires -messageCredits -credits')
      .lean();
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user);
  } catch (error) {
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

    // Validate and sanitize phone if provided
    if (updateData.phone !== undefined) {
      const cleanPhone = String(updateData.phone || '').replace(/\D/g, '').slice(-10);
      if (cleanPhone) {
        if (!/^[6-9]\d{9}$/.test(cleanPhone)) {
          return res.status(400).json({ message: 'Enter a valid 10-digit Indian mobile number' });
        }
        const clash = await User.findOne({ phone: cleanPhone, _id: { $ne: userId } }).select('_id').lean();
        if (clash) {
          return res.status(409).json({ message: 'This mobile number is already registered' });
        }
        user.phone = cleanPhone;
      } else {
        user.phone = undefined;
      }
    }

    // Basic scalar fields (phone is handled separately above)
    const basicFields = [
      'username', 'name', 'bio', 'city', 'linkedinProfile',
      'yearsOfExperience', 'price', 'acceptsCredits',
      'isStrategyComplete', 'chatDisabled'
    ];
    basicFields.forEach(field => {
      if (updateData[field] !== undefined) user[field] = updateData[field];
    });

    // Frontend convenience fields: college/branch/year/cgpa → education[0]
    const hasFlatEdu = updateData.college !== undefined
      || updateData.branch !== undefined
      || updateData.year !== undefined
      || updateData.cgpa !== undefined;

    if (hasFlatEdu) {
      const existing = user.education?.[0]?.toObject?.() || user.education?.[0] || {};
      const college = updateData.college !== undefined ? updateData.college : (existing.institutionName || existing.institution || '');
      const branch  = updateData.branch  !== undefined ? updateData.branch  : (existing.field || '');
      const yr      = updateData.year    !== undefined ? updateData.year    : (existing.year || '');
      const cgRaw   = updateData.cgpa    !== undefined ? Number(updateData.cgpa) : existing.cgpa;
      const cg      = (cgRaw === null || cgRaw === undefined || isNaN(cgRaw)) ? undefined : cgRaw;
      user.education = [
        { institution: college, institutionName: college, degree: existing.degree || '', field: branch, year: yr, cgpa: cg },
        ...(user.education || []).slice(1),
      ];
    }

    // Frontend convenience: goals array → interests (only if interests not sent directly)
    if (updateData.goals !== undefined && updateData.interests === undefined) {
      user.interests = Array.isArray(updateData.goals) ? updateData.goals : [];
    }

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

    // Services offered — validate against the platform catalog (ignore unknown ids)
    if (updateData.servicesOffered !== undefined) {
      user.servicesOffered = sanitizeServiceIds(updateData.servicesOffered);
    }

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
              cgpa           : e.cgpa && !isNaN(Number(e.cgpa)) ? Number(e.cgpa) : undefined
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

    // 2. Groq JSON-mode extraction → maps straight onto the mentor-matching fields.
    const system = `You extract a mentor profile from a LinkedIn/résumé PDF for an Indian engineering career platform.
Return ONLY a JSON object with EXACTLY these keys (use "" or [] when unknown — never invent):
{
  "name": "",
  "bio": "a sharp 2-sentence summary of who they are and what they cracked",
  "city": "",
  "linkedinProfile": "",
  "topCompanies": ["company/institute names they worked or interned at, e.g. Amazon, IIM Ahmedabad"],
  "expertise": ["concrete skills, e.g. Python, DSA, System Design, Guesstimates"],
  "specialTags": ["distinctive achievements from this fixed list when applicable: IIM, IIT, IIIT, BITS, FAANG, Off Campus Internship, Research Intern, Foreign Internship, PPO, GATE, Consulting, Product, Quant, SDE, Startup"],
  "primaryDomain": "one of: internship | placement | both (their main mentoring area)",
  "companyDomain": "one of: Tech | Data Analytics | Consulting | Product | Core Engineering",
  "education": [{ "institution": "full college name", "degree": "B.Tech/M.Tech/MBA", "field": "branch/major", "year": "grad year YYYY" }]
}
Output ONLY the JSON object.`;

    const parsedData = await callGroqJSON([
      { role: 'system', content: system },
      { role: 'user', content: `RESUME / LINKEDIN TEXT:\n${resumeText.substring(0, 9000)}\n\nExtract the JSON now.` },
    ]);

    return res.json({ success: true, data: parsedData, rawTextLength: resumeText.length });
  } catch (error) {
    console.error('POST /parse-linkedin error:', error);
    res.status(500).json({ message: 'Failed to process resume', error: error.message });
  }
});

// ─────────────────────────────────────────────
//  POST /:id/view  — track a profile view from answer cards / match results
//  Only counts when viewer ≠ mentor. Fire-and-forget from the frontend.
// ─────────────────────────────────────────────
router.post('/:id/view', async (req, res) => {
  try {
    const targetId = req.params.id;
    // Decode the token if present, but don't block on missing/invalid token
    let viewerId = null;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
        viewerId = decoded._id || decoded.id || decoded.userId;
      } catch { /* ignore */ }
    }
    // Don't count self-views
    if (viewerId && viewerId.toString() === targetId) {
      return res.json({ ok: true, counted: false });
    }
    await User.findByIdAndUpdate(targetId, { $inc: { profileViews: 1 } });
    res.json({ ok: true, counted: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
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
