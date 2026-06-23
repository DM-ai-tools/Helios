import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-clicktrends-key-for-dev';
const COOKIE_NAME = 'ct_auth_token';

/**
 * Middleware for protecting API routes.
 * Returns 401 Unauthorized JSON if no valid token is found.
 */
export const requireAuthAPI = (req, res, next) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, email, ... }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  }
};

/**
 * Middleware for protecting frontend HTML files.
 * Redirects to /login.html if no valid token is found.
 */
export const requireAuthHTML = (req, res, next) => {
  // API routes carry their own JSON auth guard (requireAuthAPI) and must NOT be
  // HTML-redirected — otherwise an unauthenticated/expired API call returns a
  // 302 to login.html instead of a 401 JSON the client can act on.
  if (req.path.startsWith('/api/')) {
    return next();
  }

  // Exclude public paths
  const publicPaths = ['/login.html', '/register.html'];
  if (publicPaths.includes(req.path)) {
    return next();
  }

  // Allow internal headless browser (Puppeteer) to render PDFs without cookies
  if (req.path === '/report.html' && req.query.pdf === 'true') {
    return next();
  }

  const token = req.cookies[COOKIE_NAME];
  if (!token) {
    return res.redirect('/login.html');
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.redirect('/login.html');
  }
};
