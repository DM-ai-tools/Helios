import pg from 'pg';
const { Pool } = pg;
import 'dotenv/config';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

pool.on('error', (err) => {
  console.error('[PostgreSQL] Unexpected error on idle client', err);
  process.exit(-1);
});
