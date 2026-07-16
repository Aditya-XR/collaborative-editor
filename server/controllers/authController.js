import User from '../models/User.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import fs from 'fs';

// C++ namespace std naming equivalents for clean scope lookup
const { log, error } = console;
const { stringify } = JSON;

const writeLog = (msg, obj) => {
  try {
    fs.appendFileSync('oauth-debug.log', `${new Date().toISOString()} - ${msg}: ${JSON.stringify(obj)}\n`);
  } catch (e) {}
};

const COLORS = [
  '#7c3aed', '#3b82f6', '#ec4899', '#f59e0b', 
  '#10b981', '#ef4444', '#06b6d4', '#8b5cf6'
];

const getRandomColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];

const generateAccessToken = (user) => {
  return jwt.sign(
    {
      _id: user._id,
      email: user.email,
      name: user.name,
      avatar: user.avatar,
      color: user.color,
    },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
};

const generateRefreshToken = (user) => {
  return jwt.sign(
    { _id: user._id },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );
};

const setRefreshTokenCookie = (res, token) => {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('refresh_token', token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'None' : 'Lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
};

export const register = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ message: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const color = getRandomColor();

    const user = await User.create({
      name,
      email: email.toLowerCase(),
      password: hashedPassword,
      color,
    });

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    user.refreshTokens.push(refreshToken);
    await user.save();

    setRefreshTokenCookie(res, refreshToken);

    res.status(201).json({
      accessToken,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        color: user.color,
      },
    });
  } catch (err) {
    error('Register error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !user.password) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    user.refreshTokens.push(refreshToken);
    await user.save();

    setRefreshTokenCookie(res, refreshToken);

    res.json({
      accessToken,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        color: user.color,
      },
    });
  } catch (err) {
    error('Login error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const logout = async (req, res) => {
  try {
    const refreshToken = req.cookies?.refresh_token;
    if (refreshToken) {
      const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
      const user = await User.findById(decoded._id);
      if (user) {
        user.refreshTokens = user.refreshTokens.filter((t) => t !== refreshToken);
        await user.save();
      }
    }
    res.clearCookie('refresh_token');
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    res.clearCookie('refresh_token');
    res.json({ message: 'Logged out' });
  }
};

export const refresh = async (req, res) => {
  try {
    const refreshToken = req.cookies?.refresh_token;
    if (!refreshToken) {
      return res.status(401).json({ message: 'No refresh token' });
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    } catch (err) {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    const user = await User.findById(decoded._id);
    if (!user || !user.refreshTokens.includes(refreshToken)) {
      return res.status(403).json({ message: 'Token is compromised or revoked' });
    }

    // Refresh Token Rotation (re-issue both tokens)
    const newAccessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user);

    // Swap refresh tokens
    user.refreshTokens = user.refreshTokens.filter((t) => t !== refreshToken);
    user.refreshTokens.push(newRefreshToken);
    await user.save();

    setRefreshTokenCookie(res, newRefreshToken);

    res.json({
      accessToken: newAccessToken,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        color: user.color,
      },
    });
  } catch (err) {
    error('Token refresh error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const googleCallback = async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) {
      return res.redirect(`${process.env.CLIENT_URL}/login?error=no_code_provided`);
    }

    // Determine the correct redirect URI dynamically based on the current host
    const host = req.get('host');
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const redirectUri = `${protocol}://${host}/api/auth/google/callback`;

    // Exchange code for Google tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) {
      error('Google Token Exchange Error:', tokenData);
      writeLog('Google Token Exchange Error', tokenData);
      return res.redirect(`${process.env.CLIENT_URL}/login?error=google_token_exchange_failed`);
    }

    // Fetch user details from Google userinfo endpoint
    const userResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });

    const googleUser = await userResponse.json();
    if (!userResponse.ok || !googleUser.email) {
      error('Google Userinfo Error:', googleUser);
      writeLog('Google Userinfo Error', googleUser);
      return res.redirect(`${process.env.CLIENT_URL}/login?error=google_userinfo_failed`);
    }

    // Find or create user
    let user = await User.findOne({ email: googleUser.email.toLowerCase() });
    if (user) {
      // Update Google ID and Avatar if not set
      let needsSave = false;
      if (!user.googleId) {
        user.googleId = googleUser.id;
        needsSave = true;
      }
      if (!user.avatar && googleUser.picture) {
        user.avatar = googleUser.picture;
        needsSave = true;
      }
      if (needsSave) {
        await user.save();
      }
    } else {
      user = await User.create({
        name: googleUser.name || googleUser.given_name || 'Google User',
        email: googleUser.email.toLowerCase(),
        googleId: googleUser.id,
        avatar: googleUser.picture || '',
        color: getRandomColor(),
      });
    }

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    user.refreshTokens.push(refreshToken);
    await user.save();

    setRefreshTokenCookie(res, refreshToken);

    // Redirect client back to the SPA auth landing page
    res.redirect(`${process.env.CLIENT_URL}/auth/success?token=${accessToken}`);
  } catch (err) {
    error('Google OAuth error:', err);
    writeLog('Google OAuth error', { message: err.message, stack: err.stack });
    res.redirect(`${process.env.CLIENT_URL}/login?error=internal_server_error`);
  }
};

export const getAuthConfig = (req, res) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || ''
  });
};
