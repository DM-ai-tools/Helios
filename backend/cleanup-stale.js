import dotenv from 'dotenv';
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Clear broken Meta Ads template
const r1 = await pool.query(`DELETE FROM page_templates WHERE service_name LIKE '%Meta Ads%'`);
console.log('Deleted page_templates:', r1.rowCount);

// Also clear stale sub_service_pages that used EJS/mock data
const r2 = await pool.query(`DELETE FROM sub_service_pages WHERE slug LIKE 'facebook%' OR slug LIKE 'local-seo%' OR slug LIKE 'technical-seo%' OR slug LIKE 'e-commerce%'`);
console.log('Deleted stale sub_service_pages:', r2.rowCount);

await pool.end();
console.log('Done.');
