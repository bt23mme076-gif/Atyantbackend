// backend/routes/auth.js
import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { OAuth2Client } from 'google-auth-library';
import User from '../models/User.js';
import passport from 'passport';
import { protect } from '../middleware/authMiddleware.js';
import {
  sendUserWelcomeEmail,
  sendMentorWelcomeEmail,
  sendPasswordOTPEmail,
  sendEmailVerificationOTP,     // ← NEW
} from '../utils/emailService.js';

// ─── Rate limiters ────────────────────────────────────────────────────────────
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many password reset attempts. Please try again in 15 minutes.' },
});

// Separate limiter for the signup OTP send / resend
const signupOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many verification requests. Please try again in 15 minutes.' },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Fire-and-forget welcome email — never blocks signup if email fails.
const sendWelcomeEmail = (user) => {
  const fn = user.role === 'mentor' ? sendMentorWelcomeEmail : sendUserWelcomeEmail;
  fn(user.email, user.name || user.username)
    .catch(err => console.error('Welcome email failed (non-fatal):', err.message));
};

const getFrontendUrl = () => {
  if (process.env.NODE_ENV !== 'production' && process.env.LOCAL_FRONTEND_URL) {
    return process.env.LOCAL_FRONTEND_URL;
  }
  return process.env.FRONTEND_URL || 'http://localhost:5173';
};

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const router = express.Router();

const signUserToken = (user) =>
  jwt.sign(
    { userId: user._id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 1 — Initiate signup: validate fields, store pending user, send OTP
//  POST /api/auth/signup-initiate
// ─────────────────────────────────────────────────────────────────────────────
router.post('/signup-initiate', signupOtpLimiter, async (req, res) => {
  try {
    const { username, email, password, role, phone } = req.body;

    // ── Basic validation ───────────────────────────────────────────────────
    if (!username || !email || !password || !phone) {
      return res.status(400).json({ message: 'All fields required including mobile number' });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }

    const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);
    if (!/^[6-9]\d{9}$/.test(cleanPhone)) {
      return res.status(400).json({ message: 'Enter a valid 10-digit Indian mobile number' });
    }

    const cleanEmail = email.trim().toLowerCase();

    // ── Check for duplicate accounts ─────────────────────────────────────
    // Block if a record already exists AND is either:
    //   • explicitly verified (isEmailVerified: true), OR
    //   • an OLD user whose field is undefined (pre-OTP-feature accounts)
    // We only allow re-initiating for a record that was created by the NEW
    // flow but hasn't been verified yet (isEmailVerified === false).
    const existingUser = await User.findOne({
      $or: [
        { email: cleanEmail },
        { username },
        { phone: cleanPhone },
      ]
    });

    if (existingUser && existingUser.isEmailVerified !== false) {
      // This is either an old user (undefined) or a verified new user — block.
      if (existingUser.email === cleanEmail) {
        return res.status(409).json({ message: 'Email already registered' });
      }
      if (existingUser.username === username) {
        return res.status(409).json({ message: 'Username already taken' });
      }
      return res.status(409).json({ message: 'Mobile number already registered' });
    }

    // ── Generate OTP ──────────────────────────────────────────────────────
    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 min
    const hashedPassword = await bcrypt.hash(password, 10);

    // ── Upsert the unverified user record ─────────────────────────────────
    // If user previously initiated but never verified, we overwrite their OTP
    // and pending fields so they can retry cleanly.
    await User.findOneAndUpdate(
      { email: cleanEmail },
      {
        $set: {
          username,
          email: cleanEmail,
          password: hashedPassword,
          phone: cleanPhone,
          role: role || 'user',
          isEmailVerified: false,
          emailOTP: otp,
          emailOTPExpires: otpExpires,
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // ── Send OTP email ────────────────────────────────────────────────────
    await sendEmailVerificationOTP(cleanEmail, otp, username);

    return res.status(200).json({
      message: 'OTP sent to your email. Please verify to complete registration.',
    });
  } catch (error) {
    console.error('signup-initiate error:', error);
    if (error.name === 'ValidationError') {
      return res.status(400).json({ message: Object.values(error.errors).map(e => e.message).join(', ') });
    }
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(409).json({ message: `${field} already exists` });
    }
    return res.status(500).json({ message: 'Error initiating signup', error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 2 — Verify OTP and activate account
//  POST /api/auth/signup-verify
// ─────────────────────────────────────────────────────────────────────────────
router.post('/signup-verify', signupOtpLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: 'Email and OTP are required' });
    }

    const cleanEmail = email.trim().toLowerCase();

    const user = await User.findOne({ email: cleanEmail })
      .select('+emailOTP +emailOTPExpires +password');

    if (!user) {
      return res.status(404).json({ message: 'No pending registration found for this email. Please sign up again.' });
    }

    if (user.isEmailVerified) {
      return res.status(400).json({ message: 'Email already verified. Please log in.' });
    }

    if (!user.emailOTP || user.emailOTP !== otp.trim()) {
      return res.status(400).json({ message: 'Invalid OTP. Please check the code and try again.' });
    }

    if (!user.emailOTPExpires || user.emailOTPExpires < new Date()) {
      return res.status(400).json({ message: 'OTP has expired. Please request a new one.' });
    }

    // ── Activate account ──────────────────────────────────────────────────
    user.isEmailVerified = true;
    user.emailOTP = null;
    user.emailOTPExpires = null;
    await user.save();

    // Attribute referral if stored
    // (handled client-side via `ref` in signup-initiate — already done above)

    // Send welcome email (non-blocking)
    sendWelcomeEmail(user);

    const token = signUserToken(user);

    return res.status(200).json({
      message: 'Email verified! Account created successfully.',
      token,
      role: user.role,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('signup-verify error:', error);
    return res.status(500).json({ message: 'Error verifying OTP', error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Resend OTP for signup verification
//  POST /api/auth/signup-resend-otp
// ─────────────────────────────────────────────────────────────────────────────
router.post('/signup-resend-otp', signupOtpLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required' });

    const cleanEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: cleanEmail, isEmailVerified: false })
      .select('+emailOTP +emailOTPExpires');

    if (!user) {
      return res.status(404).json({ message: 'No pending verification found. Please sign up again.' });
    }

    const otp = crypto.randomInt(100000, 1000000).toString();
    user.emailOTP = otp;
    user.emailOTPExpires = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();

    await sendEmailVerificationOTP(cleanEmail, otp, user.username);

    return res.json({ message: 'A new OTP has been sent to your email.' });
  } catch (error) {
    console.error('signup-resend-otp error:', error);
    return res.status(500).json({ message: 'Error resending OTP' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  LOGIN
//  POST /api/auth/login
// ─────────────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    let user;
    const cleanPhone = String(email || '').replace(/\D/g, '').slice(-10);
    const isPhone = /^[6-9]\d{9}$/.test(cleanPhone);

    if (isPhone) {
      user = await User.findOne({
        $or: [{ email: email.toLowerCase() }, { phone: cleanPhone }]
      }).select('+password');
    } else {
      user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    }

    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    if (!user.password) {
      return res.status(400).json({
        message: 'This account was created with Google. Please use "Continue with Google" to login.'
      });
    }

    // Block only accounts explicitly created via the NEW OTP flow that haven't verified yet.
    // Old users have isEmailVerified === undefined (not false), so they pass through unaffected.
    if (user.isEmailVerified === false && user.password) {
      return res.status(403).json({
        message: 'Please verify your email before logging in. Check your inbox for the OTP.',
        requiresEmailVerification: true,
        email: user.email,
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const token = signUserToken(user);
    const requiresCalendarSetup = user.role === 'mentor' && !user.calendarConnected;

    return res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        name: user.name,
        email: user.email,
        role: user.role,
        profilePicture: user.profilePicture,
        calendarConnected: user.calendarConnected,
      },
      requiresCalendarSetup,
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GOOGLE LOGIN (OAuth — email auto-verified)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/google-login', async (req, res) => {
  console.time('google-login-operation');
  const { token } = req.body;
  try {
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const { name, email, sub, picture } = ticket.getPayload();
    let user = await User.findOne({ email });

    if (!user) {
      let baseUsername = name ? name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() : 'user';
      let username = baseUsername;
      let tries = 0;
      while (await User.findOne({ username })) {
        username = `${baseUsername}${Math.floor(Math.random() * 10000)}`;
        if (++tries > 10) { username = `${baseUsername}${Date.now()}`; break; }
      }
      user = new User({
        username,
        email,
        googleId: sub,
        role: 'user',
        profilePicture: picture || null,
        isEmailVerified: true,  // Google-verified emails are trusted
      });
      try {
        await user.save();
        sendWelcomeEmail(user);
      } catch (err) {
        return res.status(400).json({ message: 'Signup required. Please sign up first.' });
      }
    } else if (!user.googleId) {
      user.googleId = sub;
      user.isEmailVerified = true; // Mark verified since Google confirmed it
      await user.save();
    }

    const jwtToken = signUserToken(user);
    console.timeEnd('google-login-operation');

    return res.json({
      token: jwtToken,
      role: user.role,
      user: {
        _id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        profilePicture: user.profilePicture,
        credits: user.credits,
        calendarConnected: user.calendarConnected || false,
      },
      requiresCalendarSetup: user.role === 'mentor' && !user.calendarConnected,
    });
  } catch (error) {
    console.timeEnd('google-login-operation');
    console.error('Google auth error:', error);
    return res.status(400).json({ message: 'Google authentication failed.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  PASSWORD RESET FLOW (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/forgot-password', passwordResetLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: 'Please enter a valid email address' });
    }
    const user = await User.findOne({ email }).select('+resetOTP +resetOTPExpires');
    if (!user) return res.json({ message: 'If the account exists, an OTP has been sent.' });

    const otp = crypto.randomInt(100000, 1000000).toString();
    user.resetOTP = otp;
    user.resetOTPExpires = Date.now() + 10 * 60 * 1000;
    await user.save();
    await sendPasswordOTPEmail(email, otp);

    return res.json({ message: 'If the account exists, an OTP has been sent.' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/verify-reset-code', passwordResetLimiter, async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: 'Please enter a valid email address' });
    }
    const user = await User.findOne({ email }).select('+resetOTP +resetOTPExpires');
    if (!user || user.resetOTP !== code || user.resetOTPExpires < Date.now()) {
      return res.status(400).json({ message: 'Invalid or expired code' });
    }
    return res.json({ message: 'Code verified' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/reset-password', passwordResetLimiter, async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: 'Please enter a valid email address' });
    }
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters long' });
    }

    const user = await User.findOne({ email }).select('+resetOTP +resetOTPExpires +password');
    if (!user || user.resetOTP !== code || user.resetOTPExpires < Date.now()) {
      return res.status(400).json({ message: 'Invalid or expired OTP' });
    }

    user.password = await bcrypt.hash(newPassword, 8);
    user.resetOTP = null;
    user.resetOTPExpires = null;
    await user.save();

    return res.json({ message: 'Password reset successful' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GOOGLE OAUTH (Passport)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/google', passport.authenticate('google'));

router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: `${getFrontendUrl()}/login?error=auth_failed` }),
  (req, res) => {
    try {
      const token = jwt.sign(
        { userId: req.user._id, role: req.user.role },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );
      res.redirect(`${getFrontendUrl()}/?token=${token}`);
    } catch (error) {
      console.error('OAuth callback error:', error);
      res.redirect(`${getFrontendUrl()}/login?error=auth_failed`);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  MISC
// ─────────────────────────────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  if (req.isAuthenticated()) {
    return res.json({ id: req.user._id, email: req.user.email, name: req.user.name, picture: req.user.picture });
  }
  return res.status(401).json({ error: 'Not authenticated' });
});

router.post('/logout', (req, res) => {
  req.logout((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    req.session.destroy();
    res.json({ success: true, message: 'Logged out successfully' });
  });
});

router.get('/calendar-status', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('calendarConnected calendarProvider email');
    res.json({ connected: user.calendarConnected || false, provider: user.calendarProvider || null, email: user.email });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check calendar status' });
  }
});

router.post('/disconnect-calendar', protect, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user.userId, {
      calendarConnected: false, calendarProvider: null, accessToken: null, refreshToken: null
    });
    res.json({ success: true, message: 'Calendar disconnected' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to disconnect calendar' });
  }
});

export default router;
