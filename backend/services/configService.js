// ============================================================
// backend/services/configService.js
// Admin Configuration service.
//
// Responsibilities:
//   - Catalog the environment variables used across the codebase, grouped
//     into categories with human descriptions.
//   - Read effective values (admin_config DB override > process.env), with
//     secret values masked for transit (****abcd).
//   - Persist changes durably to the admin_config table, apply them to
//     process.env at runtime, and best-effort write the .env file on disk.
//   - Run real "test" pings for integration keys.
//
// Security: secret values are encrypted at rest in admin_config and are NEVER
// logged or returned raw except via getRawValue() (used by the password-gated
// reveal/test endpoints).
// ============================================================
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import axios from 'axios';
import { pool } from '../db/db.js';
import { encryptToken, decryptToken } from './cryptoService.js';
import redisClient from './redisClient.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, '../../.env');

// ─── Catalog ──────────────────────────────────────────────────
// Known variables discovered across the codebase. Unknown keys found in
// process.env / admin_config are surfaced under "Other".
const CATALOG = [
  // Database
  { key: 'DATABASE_URL', category: 'Database', description: 'PostgreSQL connection string. Changing requires a restart to reconnect the pool.' },
  { key: 'REDIS_URL', category: 'Database', description: 'Redis connection string (cache, queues, SSE). Restart required to reconnect.' },
  // Authentication
  { key: 'JWT_SECRET', category: 'Authentication', description: 'Secret used to sign login session JWTs.' },
  { key: 'ENCRYPTION_KEY', category: 'Authentication', description: 'AES-256 key for encrypting stored integration tokens & secret config.' },
  // Integrations — AI
  { key: 'ANTHROPIC_API_KEY', category: 'Integrations', description: 'Primary Anthropic (Claude) API key.' },
  { key: 'ANTHROPIC_API_KEY_2', category: 'Integrations', description: 'Anthropic key #2 (parallel plugin execution).' },
  { key: 'ANTHROPIC_API_KEY_3', category: 'Integrations', description: 'Anthropic key #3 (parallel plugin execution).' },
  { key: 'ANTHROPIC_API_KEY_4', category: 'Integrations', description: 'Anthropic key #4 (parallel plugin execution).' },
  { key: 'ANTHROPIC_API_KEY_5', category: 'Integrations', description: 'Anthropic key #5 (parallel plugin execution).' },
  { key: 'ANTHROPIC_API_KEY_6', category: 'Integrations', description: 'Anthropic key #6 (parallel plugin execution).' },
  { key: 'OPENROUTER_API_KEY', category: 'Integrations', description: 'OpenRouter key — Perplexity web research during the crawl phase.' },
  { key: 'OPENAI_API_KEY', category: 'Integrations', description: 'OpenAI API key (alt name).' },
  { key: 'OPEN_AI_APIKEY', category: 'Integrations', description: 'OpenAI API key used for PDF report synthesis.' },
  { key: 'OPENAI_MODEL', category: 'Integrations', description: 'OpenAI model id for PDF report generation (e.g. gpt-4o-mini).' },
  { key: 'RESEND_API_KEY', category: 'Integrations', description: 'Resend email API key. Blank = mock/log-only email.' },
  { key: 'FROM_EMAIL', category: 'Integrations', description: 'Default From address for outbound email.' },
  { key: 'SMTP_HOST', category: 'Integrations', description: 'SMTP host (email fallback).' },
  { key: 'SMTP_PORT', category: 'Integrations', description: 'SMTP port (e.g. 587).' },
  { key: 'SMTP_USER', category: 'Integrations', description: 'SMTP username.' },
  { key: 'SMTP_PASS', category: 'Integrations', description: 'SMTP password.' },
  { key: 'SMTP_SECURE', category: 'Integrations', description: 'SMTP TLS flag (true/false).' },
  { key: 'WORDPRESS_SITE_URL', category: 'Integrations', description: 'WordPress site base URL for deployments.' },
  { key: 'WORDPRESS_USERNAME', category: 'Integrations', description: 'WordPress username (REST/Application Password).' },
  { key: 'WORDPRESS_PASSWORD', category: 'Integrations', description: 'WordPress application password.' },
  // Bot / Automation
  { key: 'IMPLEMENTATION_BOT_URL', category: 'Bot / Automation', description: 'Implementation bot endpoint URL.' },
  { key: 'IMPLEMENTATION_BOT_TOKEN', category: 'Bot / Automation', description: 'Implementation bot auth token.' },
  // App Config
  { key: 'PORT', category: 'App Config', description: 'HTTP port the server listens on.' },
  { key: 'NODE_ENV', category: 'App Config', description: 'Runtime environment (production/development).' },
  { key: 'CORS_ORIGIN', category: 'App Config', description: 'Allowed CORS origin (* = any).' },
  { key: 'BASE_URL', category: 'App Config', description: 'Public base URL used in report links.' },
  { key: 'FRONTEND_URL', category: 'App Config', description: 'Public frontend URL.' },
  { key: 'RAILWAY_PUBLIC_DOMAIN', category: 'App Config', description: 'Railway-provided public domain.' },
];

const CATALOG_MAP = Object.fromEntries(CATALOG.map(e => [e.key, e]));

// Keys whose change cannot hot-reload an open connection pool.
const RESTART_REQUIRED = new Set(['DATABASE_URL', 'REDIS_URL', 'PORT']);

// ─── Helpers ──────────────────────────────────────────────────
export function isSecretKey(name) {
  return /(KEY|TOKEN|SECRET|PASSWORD|PASS|APIKEY)/i.test(name);
}

function categoryFor(name) {
  if (CATALOG_MAP[name]) return CATALOG_MAP[name].category;
  if (/^(DB_|DATABASE|REDIS|POSTGRES)/i.test(name)) return 'Database';
  if (/(JWT|SESSION|ENCRYPTION|AUTH)/i.test(name)) return 'Authentication';
  if (/(BOT)/i.test(name)) return 'Bot / Automation';
  if (/(API|KEY|TOKEN|WORDPRESS|WEBFLOW|MAILCHIMP|WIX|SMTP|EMAIL|RESEND|OPENAI|ANTHROPIC|OPENROUTER)/i.test(name)) return 'Integrations';
  if (/(PORT|NODE_ENV|CORS|URL|DOMAIN|HOST)/i.test(name)) return 'App Config';
  return 'Other';
}

export function maskValue(value) {
  if (value === undefined || value === null || value === '') return '';
  const str = String(value);
  if (str.length <= 4) return '****';
  return '****' + str.slice(-4);
}

// In-memory cache of which catalog/db keys are secret (avoids re-deriving).
async function loadOverrides() {
  try {
    const { rows } = await pool.query(`SELECT key, value, category, description, is_secret FROM admin_config;`);
    return rows;
  } catch (err) {
    console.error('[ConfigService] loadOverrides error:', err.message);
    return [];
  }
}

// Decrypt a stored override value if it is a secret.
function decodeStored(row) {
  if (!row) return undefined;
  return row.is_secret ? decryptToken(row.value) : row.value;
}

// ─── Public API ───────────────────────────────────────────────

/**
 * Return the full config list for the admin UI — masked, grouped, never raw.
 * Effective value precedence: admin_config override > process.env.
 */
export async function getConfigList() {
  const overrides = await loadOverrides();
  const overrideMap = Object.fromEntries(overrides.map(r => [r.key, r]));

  // Union of catalog keys, env keys, and override keys.
  const keys = new Set([
    ...CATALOG.map(c => c.key),
    ...overrides.map(o => o.key),
  ]);
  // Include any process.env key that looks like an app config (UPPER_SNAKE_CASE)
  // and is either in our catalog or already overridden — avoids dumping the
  // entire OS environment (PATH, etc.).
  for (const k of Object.keys(process.env)) {
    if (CATALOG_MAP[k] || overrideMap[k]) keys.add(k);
  }

  const items = [];
  for (const key of keys) {
    const secret = overrideMap[key]?.is_secret ?? isSecretKey(key);
    const effective = overrideMap[key] !== undefined
      ? decodeStored(overrideMap[key])
      : process.env[key];
    const hasValue = effective !== undefined && effective !== null && effective !== '';
    items.push({
      key,
      category: overrideMap[key]?.category || categoryFor(key),
      description: overrideMap[key]?.description || CATALOG_MAP[key]?.description || '',
      isSecret: secret,
      hasValue,
      // Secrets: masked. Non-secrets: full value shown.
      display: secret ? maskValue(effective) : (effective ?? ''),
      overridden: overrideMap[key] !== undefined,
      restartRequired: RESTART_REQUIRED.has(key),
      updatedAt: overrideMap[key]?.updated_at || null,
    });
  }

  // Group by category, stable key sort within.
  const grouped = {};
  for (const item of items.sort((a, b) => a.key.localeCompare(b.key))) {
    (grouped[item.category] ||= []).push(item);
  }
  return grouped;
}

/**
 * Raw (decrypted) effective value for a single key. Used by password-gated
 * reveal/test endpoints only — never expose without re-auth.
 */
export async function getRawValue(key) {
  const { rows } = await pool.query(`SELECT key, value, is_secret FROM admin_config WHERE key = $1;`, [key]);
  if (rows[0]) return decodeStored(rows[0]);
  return process.env[key];
}

/**
 * Persist one config change: admin_config (durable) + process.env (runtime) +
 * best-effort .env file. Returns { key, restartRequired, oldMasked, newMasked }.
 * Caller is responsible for re-auth and audit-trail logging.
 */
export async function setConfig(key, value, updatedBy) {
  const secret = isSecretKey(key);
  const oldRaw = await getRawValue(key);
  const stored = secret ? encryptToken(value) : value;

  await pool.query(
    `INSERT INTO admin_config (key, value, category, description, is_secret, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, category = EXCLUDED.category,
           description = EXCLUDED.description, is_secret = EXCLUDED.is_secret,
           updated_by = EXCLUDED.updated_by, updated_at = NOW();`,
    [key, stored, categoryFor(key), CATALOG_MAP[key]?.description || '', secret, updatedBy]
  );

  // Apply at runtime.
  process.env[key] = value;

  // Best-effort .env write (works in dev/local; ephemeral on Railway).
  let envWritten = false;
  try {
    envWritten = writeEnvFile(key, value);
  } catch (err) {
    console.error('[ConfigService] .env write failed (non-fatal):', err.message);
  }

  return {
    key,
    restartRequired: RESTART_REQUIRED.has(key),
    envWritten,
    oldMasked: secret ? maskValue(oldRaw) : (oldRaw ?? ''),
    newMasked: secret ? maskValue(value) : value,
    isSecret: secret,
  };
}

// Upsert/replace a single KEY=value line in the .env file. Returns true on success.
function writeEnvFile(key, value) {
  let lines = [];
  if (fs.existsSync(ENV_PATH)) {
    lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
  }
  const line = `${key}=${value}`;
  const idx = lines.findIndex(l => l.match(new RegExp(`^\\s*${key}\\s*=`)));
  if (idx !== -1) lines[idx] = line;
  else lines.push(line);
  fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf8');
  return true;
}

/**
 * Real connectivity/validity test for a key. Returns { ok, detail }.
 * Uses the current effective value unless an explicit `value` is supplied.
 */
export async function testKey(key, explicitValue) {
  const value = explicitValue ?? await getRawValue(key);
  try {
    // WordPress credentials — ping the REST API.
    if (key.startsWith('WORDPRESS_')) {
      let siteUrl = (await getRawValue('WORDPRESS_SITE_URL')) || '';
      const username = await getRawValue('WORDPRESS_USERNAME');
      const password = await getRawValue('WORDPRESS_PASSWORD');
      if (!siteUrl) return { ok: false, detail: 'WORDPRESS_SITE_URL not set.' };
      siteUrl = siteUrl.replace(/\/$/, '');
      if (!/^https?:\/\//.test(siteUrl)) siteUrl = 'https://' + siteUrl;
      const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
      const r = await axios.get(`${siteUrl}/wp-json/wp/v2/users/me`, {
        headers: { Authorization: authHeader, Accept: 'application/json' }, timeout: 10000,
      });
      return { ok: true, detail: `Authenticated as ${r.data?.name || r.data?.slug || 'user'}.` };
    }

    if (key.startsWith('ANTHROPIC_API_KEY')) {
      if (!value) return { ok: false, detail: 'Key is empty.' };
      const r = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }],
      }, { headers: { 'x-api-key': value, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 15000, validateStatus: () => true });
      if (r.status === 200) return { ok: true, detail: 'Anthropic key valid.' };
      if (r.status === 401 || r.status === 403) return { ok: false, detail: 'Invalid/unauthorized key.' };
      return { ok: r.status < 500, detail: `Anthropic responded ${r.status}.` };
    }

    if (key === 'OPENROUTER_API_KEY') {
      if (!value) return { ok: false, detail: 'Key is empty.' };
      const r = await axios.get('https://openrouter.ai/api/v1/models', { headers: { Authorization: `Bearer ${value}` }, timeout: 12000, validateStatus: () => true });
      return { ok: r.status === 200, detail: `OpenRouter responded ${r.status}.` };
    }

    if (key === 'OPENAI_API_KEY' || key === 'OPEN_AI_APIKEY') {
      if (!value) return { ok: false, detail: 'Key is empty.' };
      const r = await axios.get('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${value}` }, timeout: 12000, validateStatus: () => true });
      return { ok: r.status === 200, detail: `OpenAI responded ${r.status}.` };
    }

    if (key === 'RESEND_API_KEY') {
      if (!value) return { ok: false, detail: 'Key is empty.' };
      const r = await axios.get('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${value}` }, timeout: 12000, validateStatus: () => true });
      return { ok: r.status === 200, detail: `Resend responded ${r.status}.` };
    }

    if (key === 'REDIS_URL') {
      const pong = await redisClient.ping();
      return { ok: pong === 'PONG', detail: `Redis ping: ${pong}.` };
    }

    if (key === 'DATABASE_URL') {
      await pool.query('SELECT 1;');
      return { ok: true, detail: 'Database connection OK.' };
    }

    if (key === 'IMPLEMENTATION_BOT_URL') {
      if (!value) return { ok: false, detail: 'URL is empty.' };
      const r = await axios.get(value, { timeout: 10000, validateStatus: () => true });
      return { ok: r.status < 500, detail: `Bot endpoint responded ${r.status}.` };
    }

    return { ok: false, detail: 'No automated test available for this key.' };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

/**
 * Apply persisted admin_config overrides into process.env at boot. Call once
 * during server startup so DB-stored config survives restarts even when the
 * .env file does not (e.g. Railway).
 */
export async function hydrateProcessEnv() {
  try {
    const overrides = await loadOverrides();
    for (const row of overrides) {
      const val = decodeStored(row);
      if (val !== undefined && val !== null) process.env[row.key] = val;
    }
    if (overrides.length) console.log(`[ConfigService] Hydrated ${overrides.length} config override(s) from DB.`);
  } catch (err) {
    console.error('[ConfigService] hydrateProcessEnv error:', err.message);
  }
}
