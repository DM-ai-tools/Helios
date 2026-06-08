import crypto from 'crypto';

const ENCRYPTION_SECRET = process.env.ENCRYPTION_KEY || 'default_clicktrends_super_secret_pass';
// Derive exactly 32-byte key from the secret using SHA-256
const key = crypto.createHash('sha256').update(ENCRYPTION_SECRET).digest();
const ivLength = 16;
const algorithm = 'aes-256-cbc';

/**
 * Encrypt plain text using AES-256-CBC
 * @param {string} text 
 * @returns {string} iv:encrypted_hex
 */
export function encryptToken(text) {
  if (!text) return null;
  try {
    const iv = crypto.randomBytes(ivLength);
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `${iv.toString('hex')}:${encrypted}`;
  } catch (err) {
    console.error('[Crypto Service] Encryption failed:', err.message);
    throw err;
  }
}

/**
 * Decrypt cipher text using AES-256-CBC
 * @param {string} encryptedText iv:encrypted_hex
 * @returns {string} plain text
 */
export function decryptToken(encryptedText) {
  if (!encryptedText) return null;
  // If not in iv:hex format (legacy plain token), return as-is
  if (!encryptedText.includes(':')) {
    return encryptedText;
  }
  try {
    const parts = encryptedText.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('[Crypto Service] Decryption failed:', err.message);
    // Return original text if decryption fails to avoid breaking on legacy/uncaught formats
    return encryptedText;
  }
}
