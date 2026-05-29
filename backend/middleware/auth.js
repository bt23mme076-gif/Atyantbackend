import jwt from 'jsonwebtoken';
import User from '../models/User.js';

// ✅ Required authentication (for protected routes like profile, messages)
const auth = async (req, res, next) => {
  try {
    const authHeader = req.header('Authorization');
    const cookieToken = req.cookies?.token;
    
    if (!authHeader && !cookieToken) {
      return res.status(401).json({
        success: false,
        message: 'No token provided'
      });
    }
    const token = authHeader ? authHeader.replace('Bearer ', '') : cookieToken;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token format'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // ✅ Fetch full user data including education
    const user = await User.findById(decoded.userId || decoded.id)
      .select('-password')
      .lean();

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not found'
      });
    }

    req.user = user;

    next();

  } catch (error) {
    console.error('❌ Authentication failed:', error.message);

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token'
      });
    }

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token has expired'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Authentication error'
    });
  }
};

// ✅ Optional authentication (for public routes like mentor search)
export const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.header('Authorization');
    
    // ✅ No token? Continue as guest
    if (!authHeader) {
      req.user = null;
      // avoid noisy per-request logs in production
      if (process.env.NODE_ENV === 'development') console.debug('👤 Guest user');
      return next();
    }

    const token = authHeader.replace('Bearer ', '');

    if (!token) {
      req.user = null;
      if (process.env.NODE_ENV === 'development') console.debug('👤 No valid token - guest user');
      return next();
    }

    // Try to verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Fetch full user data
    const user = await User.findById(decoded.userId || decoded.id)
      .select('-password')
      .lean();

    if (user) {
      req.user = user;
      if (process.env.NODE_ENV === 'development') {
        console.debug('🔐 Authenticated user:', user.username);
        console.debug('🎓 User college:', user.education?.[0]?.institution);
      }
    } else {
      req.user = null;
      if (process.env.NODE_ENV === 'development') console.debug('⚠️ User not found - continuing as guest');
    }

    next();

  } catch (error) {
    // ✅ On any auth error, just continue as guest (don't block request)
    if (process.env.NODE_ENV === 'development') console.debug('⚠️ Auth error, continuing as guest:', error.message);
    req.user = null;
    next();
  }
};

export default auth;