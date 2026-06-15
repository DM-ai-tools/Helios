import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db/db.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-clicktrends-key-for-dev';
const COOKIE_NAME = 'ct_auth_token';

// Helper to generate JWT and set cookie
function setAuthCookie(res, userId, email) {
  const token = jwt.sign({ id: userId, email }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });
}

/**
 * POST /api/auth/register
 */
router.post('/register', async (req, res) => {
  const { email, password, fullName } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  // Password validation: 8 chars, 1 uppercase, 1 lowercase, 1 number
  const pwdRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
  if (!pwdRegex.test(password)) {
    return res.status(400).json({ 
      error: 'Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, and one number.' 
    });
  }

  try {
    // Check if user exists
    const checkQuery = `SELECT id FROM users WHERE email = $1`;
    const checkRes = await pool.query(checkQuery, [email.toLowerCase()]);
    if (checkRes.rows.length > 0) {
      return res.status(400).json({ error: 'Email already in use' });
    }

    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);

    const insertQuery = `
      INSERT INTO users (email, password_hash, full_name)
      VALUES ($1, $2, $3)
      RETURNING id, email;
    `;
    const result = await pool.query(insertQuery, [email.toLowerCase(), hash, fullName || '']);
    const user = result.rows[0];

    setAuthCookie(res, user.id, user.email);
    res.json({ success: true, message: 'Registration successful' });

  } catch (err) {
    console.error('[Auth] Registration error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/login
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const query = `SELECT id, email, password_hash FROM users WHERE email = $1`;
    const { rows } = await pool.query(query, [email.toLowerCase()]);
    const user = rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    setAuthCookie(res, user.id, user.email);
    res.json({ success: true, message: 'Login successful' });

  } catch (err) {
    console.error('[Auth] Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/logout
 */
router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ success: true });
});

/**
 * GET /api/auth/me
 */
router.get('/me', async (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ authenticated: false });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ authenticated: true, user: decoded });
  } catch (err) {
    res.status(401).json({ authenticated: false });
  }
});

export default router;
