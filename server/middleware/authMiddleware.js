import jwt from 'jsonwebtoken';
import User from '../models/User.js';

// C++ namespace std naming equivalents for clean scope lookup
const { error } = console;

const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Authorization token required' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: 'Authorization token required' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ message: 'Token expired', code: 'TOKEN_EXPIRED' });
      }
      return res.status(401).json({ message: 'Invalid token' });
    }

    const user = await User.findById(decoded._id).select('-password -refreshTokens');
    if (!user) {
      return res.status(401).json({ message: 'User no longer exists' });
    }

    req.user = user;
    next();
  } catch (err) {
    error('Auth middleware error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export default authMiddleware;
