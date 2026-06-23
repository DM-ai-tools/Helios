// ============================================================
// backend/scripts/make-admin.js
// Promote (or demote) a user to admin by email.
// Usage:
//   node backend/scripts/make-admin.js user@example.com          -> admin
//   node backend/scripts/make-admin.js user@example.com user      -> demote to user
// ============================================================
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const email = (process.argv[2] || '').toLowerCase();
const role = process.argv[3] || 'admin';

if (!email) {
  console.error('Usage: node backend/scripts/make-admin.js <email> [role=admin|user]');
  process.exit(1);
}
if (!['admin', 'user'].includes(role)) {
  console.error(`Invalid role "${role}". Must be "admin" or "user".`);
  process.exit(1);
}

const isLocalhost = !process.env.DATABASE_URL ||
  process.env.DATABASE_URL.includes('localhost') ||
  process.env.DATABASE_URL.includes('127.0.0.1');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalhost ? false : { rejectUnauthorized: false }
});

(async () => {
  try {
    const { rows } = await pool.query(
      `UPDATE users SET role = $2, updated_at = NOW() WHERE email = $1 RETURNING id, email, role;`,
      [email, role]
    );
    if (rows.length === 0) {
      console.error(`No user found with email "${email}".`);
      process.exitCode = 1;
    } else {
      console.log(`Updated ${rows[0].email} -> role="${rows[0].role}"`);
    }
  } catch (err) {
    console.error('make-admin error:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
