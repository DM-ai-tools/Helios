/**
 * Puppeteer configuration file.
 *
 * In production (Railway/Docker), PUPPETEER_SKIP_DOWNLOAD=true is set in the
 * Dockerfile, so this file has no effect — no Chromium is downloaded.
 *
 * In local development (Windows), Puppeteer downloads its bundled Chromium to
 * this cache directory so it doesn't pollute the project root.
 */
const { join } = require('path');

module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
