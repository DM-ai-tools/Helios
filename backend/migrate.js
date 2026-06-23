import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

async function migrate() {
  try {
    console.log("Running migrations...");
    await pool.query(`ALTER TABLE sub_service_pages ADD COLUMN IF NOT EXISTS template_id TEXT;`);
    await pool.query(`ALTER TABLE sub_service_pages ADD COLUMN IF NOT EXISTS generated_elementor_data JSONB;`);
    await pool.query(`ALTER TABLE sub_service_pages ADD COLUMN IF NOT EXISTS builder_type TEXT;`);
    await pool.query(`ALTER TABLE sub_service_pages ADD COLUMN IF NOT EXISTS page_id TEXT;`);
    
    await pool.query(`ALTER TABLE page_templates ADD COLUMN IF NOT EXISTS template_id TEXT UNIQUE;`);
    await pool.query(`ALTER TABLE page_templates ADD COLUMN IF NOT EXISTS builder_type TEXT;`);
    await pool.query(`ALTER TABLE page_templates ADD COLUMN IF NOT EXISTS section_configuration JSONB;`);
    await pool.query(`ALTER TABLE page_templates ADD COLUMN IF NOT EXISTS master_elementor_data JSONB;`);
    await pool.query(`ALTER TABLE page_templates ADD COLUMN IF NOT EXISTS elementor_page_settings JSONB;`);

    // Fix too-restrictive CHECK constraints
    await pool.query(`ALTER TABLE page_templates DROP CONSTRAINT IF EXISTS page_templates_builder_type_check;`);
    await pool.query(`ALTER TABLE page_templates ADD CONSTRAINT page_templates_builder_type_check CHECK (builder_type IN ('elementor', 'standard_wp')) NOT VALID;`);
    await pool.query(`ALTER TABLE page_templates DROP CONSTRAINT IF EXISTS page_templates_fetch_status_check;`);
    await pool.query(`ALTER TABLE page_templates ADD CONSTRAINT page_templates_fetch_status_check CHECK (fetch_status IN ('captured', 'failed', 'fallback')) NOT VALID;`);
    
    await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS builder_type TEXT;`);
    await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS deployment_method TEXT;`);
    console.log("Migrations completed successfully!");
  } catch (err) {
    console.error("Migration error:", err);
  } finally {
    await pool.end();
  }
}

migrate();
