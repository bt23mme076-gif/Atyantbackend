import jwt from 'jsonwebtoken';

const protect = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const cookieToken = req.cookies?.token;

    if (!authHeader && !cookieToken) {
      return res.status(401).json({ message: 'Authorization header or cookie required', code: 'NO_AUTH_HEADER' });
    }

    const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : cookieToken;
    if (!token) {
      return res.status(401).json({ message: 'Token not provided', code: 'NO_TOKEN' });
    }

    // 🔴 FIX: jwt.verify() ALREADY checks expiry — manual exp check was redundant & wrong
    //         (decoded.exp * 1000 < Date.now() runs AFTER verify throws on expired tokens)
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (jwtError) {
      const code = jwtError.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
      return res.status(401).json({ message: jwtError.message, code });
    }

    // Standardise user object — all routes can safely use req.user.userId or req.user._id
    const uid = decoded._id || decoded.id || decoded.userId;
    req.user = {
      ...decoded,
      id    : uid,
      userId: uid,
      _id   : uid
    };

    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(500).json({ message: 'Internal server error during authentication', code: 'AUTH_ERROR' });
  }
};

export default protect;
export { protect };
