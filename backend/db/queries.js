// ============================================================
// backend/db/queries.js — Redis-only data layer
// ============================================================
import { v4 as uuidv4 } from 'uuid';
import redisClient from '../services/redisClient.js';
import { pool } from './db.js';
import { encryptToken, decryptToken } from '../services/cryptoService.js';

const AUDIT_TTL  = 60 * 60 * 24 * 7;  // 7 days
const PLUGIN_TTL = 60 * 60 * 24 * 7;
const IMPL_TTL   = 60 * 60 * 24 * 7;  // 7 days

// ─── Helpers ──────────────────────────────────────────────────
async function redisGet(key) {
  const val = await redisClient.get(key);
  return val ? JSON.parse(val) : null;
}

async function redisSet(key, obj, ttl = AUDIT_TTL) {
  await redisClient.setEx(key, ttl, JSON.stringify(obj));
}

/* Users */
export async function upsertUser(email) {
  const key = `user:${email}`;
  const selectQuery = `SELECT id, email, created_at FROM users WHERE email = $1;`;
  const { rows } = await pool.query(selectQuery, [email]);
  let user;
  if (rows[0]) {
    user = { id: rows[0].id, email: rows[0].email, createdAt: rows[0].created_at };
  } else {
    const insertQuery = `INSERT INTO users (email) VALUES ($1) RETURNING id, email, created_at;`;
    const insertResult = await pool.query(insertQuery, [email]);
    const newRow = insertResult.rows[0];
    user = { id: newRow.id, email: newRow.email, createdAt: newRow.created_at };
  }
  await redisSet(key, user);
  return user;
}

/* Audits */
export async function createAudit({ userId, url, industry }) {
  const insertQuery = `
    INSERT INTO audits (user_id, url, industry, status)
    VALUES ($1, $2, $3, 'pending')
    RETURNING id, user_id, url, industry, status, public_token, overall_score, executive_summary, crawled_data, synthesis, created_at, updated_at;
  `;
  const { rows } = await pool.query(insertQuery, [userId, url, industry]);
  const row = rows[0];
  const audit = {
    id: row.id,
    user_id: row.user_id,
    url: row.url,
    industry: row.industry,
    status: row.status,
    public_token: row.public_token,
    overall_score: row.overall_score,
    executive_summary: row.executive_summary,
    crawled_data: row.crawled_data,
    synthesis: row.synthesis,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  await redisSet(`audit:${audit.id}`, audit);
  await redisSet(`audit_token:${audit.public_token}`, audit.id);
  return audit;
}

export async function updateAuditStatus(auditId, status) {
  const updateQuery = `
    UPDATE audits
    SET status = $2, updated_at = NOW()
    WHERE id = $1
    RETURNING *;
  `;
  const { rows } = await pool.query(updateQuery, [auditId, status]);
  const row = rows[0];
  if (row) {
    const audit = {
      id: row.id,
      user_id: row.user_id,
      url: row.url,
      industry: row.industry,
      status: row.status,
      public_token: row.public_token,
      overall_score: row.overall_score,
      executive_summary: row.executive_summary,
      crawled_data: row.crawled_data,
      synthesis: row.synthesis,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    await redisSet(`audit:${auditId}`, audit);
  }
}

export async function updateAuditCrawledData(auditId, crawledData) {
  const updateQuery = `
    UPDATE audits
    SET crawled_data = $2, status = 'running', updated_at = NOW()
    WHERE id = $1
    RETURNING *;
  `;
  const { rows } = await pool.query(updateQuery, [auditId, JSON.stringify(crawledData)]);
  const row = rows[0];
  if (row) {
    const audit = {
      id: row.id,
      user_id: row.user_id,
      url: row.url,
      industry: row.industry,
      status: row.status,
      public_token: row.public_token,
      overall_score: row.overall_score,
      executive_summary: row.executive_summary,
      crawled_data: row.crawled_data,
      synthesis: row.synthesis,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    await redisSet(`audit:${auditId}`, audit);
  }
}

export async function finaliseAudit(auditId, { overallScore, executiveSummary, reportUrl, docxUrl, synthesisJSON }) {
  const updateQuery = `
    UPDATE audits
    SET overall_score = $2, executive_summary = $3, report_url = $4, docx_url = $5, synthesis = $6, status = 'complete', completed_at = NOW(), updated_at = NOW()
    WHERE id = $1
    RETURNING *;
  `;
  const { rows } = await pool.query(updateQuery, [
    auditId,
    overallScore,
    executiveSummary,
    reportUrl,
    docxUrl,
    synthesisJSON ? JSON.parse(synthesisJSON) : null
  ]);
  const row = rows[0];
  if (row) {
    const audit = {
      id: row.id,
      user_id: row.user_id,
      url: row.url,
      industry: row.industry,
      status: row.status,
      public_token: row.public_token,
      overall_score: row.overall_score,
      executive_summary: row.executive_summary,
      crawled_data: row.crawled_data,
      synthesis: row.synthesis,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    await redisSet(`audit:${auditId}`, audit);
  }
}

export async function getAuditById(auditId) {
  let audit = await redisGet(`audit:${auditId}`);
  if (!audit) {
    const selectQuery = `SELECT * FROM audits WHERE id = $1;`;
    const { rows } = await pool.query(selectQuery, [auditId]);
    const row = rows[0];
    if (row) {
      audit = {
        id: row.id,
        user_id: row.user_id,
        url: row.url,
        industry: row.industry,
        status: row.status,
        public_token: row.public_token,
        overall_score: row.overall_score,
        executive_summary: row.executive_summary,
        crawled_data: row.crawled_data,
        synthesis: row.synthesis,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
      await redisSet(`audit:${auditId}`, audit);
    }
  }
  return audit;
}

export async function getAuditByToken(token) {
  const auditIdVal = await redisClient.get(`audit_token:${token}`);
  let id = auditIdVal ? (auditIdVal.startsWith('"') ? JSON.parse(auditIdVal) : auditIdVal) : null;
  if (!id) {
    const selectQuery = `SELECT id FROM audits WHERE public_token = $1;`;
    const { rows } = await pool.query(selectQuery, [token]);
    if (rows[0]) {
      id = rows[0].id;
      await redisSet(`audit_token:${token}`, id);
    }
  }
  if (!id) return null;
  return await getAuditById(id);
}

/* Audit Plugins */
export async function createAuditPlugins(auditId, pluginIds, pluginMeta = {}) {
  const plugins = {};
  for (const pluginId of pluginIds) {
    const insertQuery = `
      INSERT INTO audit_plugins (audit_id, plugin_id, status)
      VALUES ($1, $2, 'queued')
      ON CONFLICT (audit_id, plugin_id) DO UPDATE SET status = 'queued'
      RETURNING *;
    `;
    const { rows } = await pool.query(insertQuery, [auditId, pluginId]);
    const row = rows[0];
    plugins[pluginId] = {
      id: row.id,
      audit_id: row.audit_id,
      plugin_id: row.plugin_id,
      status: row.status,
      score: row.score,
      summary: row.summary,
      recommendations: row.recommendations,
      claude_output: row.claude_output,
      error_message: row.error_message,
      started_at: row.started_at,
      completed_at: row.completed_at,
    };
  }
  await redisSet(`audit_plugins:${auditId}`, plugins, PLUGIN_TTL);
}

export async function updateAuditPlugin(auditId, pluginId, updates) {
  let plugins = await redisGet(`audit_plugins:${auditId}`);
  if (!plugins) {
    const list = await getAuditPlugins(auditId);
    plugins = {};
    list.forEach(p => { plugins[p.plugin_id] = p; });
  }

  if (!plugins[pluginId]) {
    plugins[pluginId] = { audit_id: auditId, plugin_id: pluginId };
  }
  const p = plugins[pluginId];

  if (updates.status          !== undefined) p.status          = updates.status;
  if (updates.score           !== undefined) p.score           = updates.score;
  if (updates.summary         !== undefined) p.summary         = updates.summary;
  if (updates.errorMessage    !== undefined) p.error_message   = updates.errorMessage;
  if (updates.recommendations !== undefined) p.recommendations = updates.recommendations;
  if (updates.claudeOutput    !== undefined) p.claude_output   = updates.claudeOutput;
  if (updates.startedAt)   p.started_at   = new Date().toISOString();
  if (updates.completedAt) p.completed_at = new Date().toISOString();

  const updateQuery = `
    INSERT INTO audit_plugins (audit_id, plugin_id, status, score, summary, recommendations, claude_output, error_message, started_at, completed_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (audit_id, plugin_id) DO UPDATE
    SET status = EXCLUDED.status,
        score = EXCLUDED.score,
        summary = EXCLUDED.summary,
        recommendations = EXCLUDED.recommendations,
        claude_output = EXCLUDED.claude_output,
        error_message = EXCLUDED.error_message,
        started_at = EXCLUDED.started_at,
        completed_at = EXCLUDED.completed_at
    RETURNING id;
  `;
  const { rows } = await pool.query(updateQuery, [
    auditId,
    pluginId,
    p.status || 'queued',
    p.score,
    p.summary,
    p.recommendations ? JSON.stringify(p.recommendations) : null,
    p.claude_output ? JSON.stringify(p.claude_output) : null,
    p.error_message,
    p.started_at,
    p.completed_at
  ]);
  if (rows[0]) {
    p.id = rows[0].id;
  }

  await redisSet(`audit_plugins:${auditId}`, plugins, PLUGIN_TTL);
}

export async function getAuditPlugins(auditId) {
  let pluginsObj = await redisGet(`audit_plugins:${auditId}`);
  if (!pluginsObj) {
    const selectQuery = `SELECT * FROM audit_plugins WHERE audit_id = $1;`;
    const { rows } = await pool.query(selectQuery, [auditId]);
    if (rows.length > 0) {
      pluginsObj = {};
      rows.forEach(row => {
        pluginsObj[row.plugin_id] = {
          id: row.id,
          audit_id: row.audit_id,
          plugin_id: row.plugin_id,
          status: row.status,
          score: row.score,
          summary: row.summary,
          recommendations: row.recommendations,
          claude_output: row.claude_output,
          error_message: row.error_message,
          started_at: row.started_at,
          completed_at: row.completed_at,
        };
      });
      await redisSet(`audit_plugins:${auditId}`, pluginsObj, PLUGIN_TTL);
    }
  }
  return pluginsObj ? Object.values(pluginsObj) : [];
}

/* Implementation Changes */
export async function saveImplementationChanges(auditId, pluginId, changes) {
  const key = `impl_changes:${auditId}:${pluginId}`;
  const records = [];
  
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const recordId = `${auditId}-${pluginId}-${i}`;
    const record = {
      id:                recordId,
      auditId,
      pluginId,
      title:             c.title             || 'Untitled Change',
      priority:          c.priority          || 'Medium',
      impactScore:       c.impactScore       || 50,
      description:       c.description       || '',
      currentState:      c.currentState      || '',
      proposedChange:    c.proposedChange    || '',
      changeType:        c.changeType        || 'general',
      status:            'pending',
      userEdit:          null,
      location:          c.location          || '',
      sourceUrl:         c.sourceUrl         || '',
      createdAt:         new Date().toISOString(),
    };
    records.push(record);

    const insertQuery = `
      INSERT INTO implementation_changes (id, audit_id, plugin_id, title, priority, impact_score, description, current_state, proposed_change, change_type, status, user_edit, location, source_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (id) DO UPDATE
      SET title = EXCLUDED.title,
          priority = EXCLUDED.priority,
          impact_score = EXCLUDED.impact_score,
          description = EXCLUDED.description,
          current_state = EXCLUDED.current_state,
          proposed_change = EXCLUDED.proposed_change,
          change_type = EXCLUDED.change_type,
          status = EXCLUDED.status,
          user_edit = EXCLUDED.user_edit,
          location = EXCLUDED.location,
          source_url = EXCLUDED.source_url,
          updated_at = NOW()
      RETURNING *;
    `;
    await pool.query(insertQuery, [
      recordId,
      auditId,
      pluginId,
      record.title,
      record.priority,
      record.impactScore,
      record.description,
      record.currentState,
      record.proposedChange,
      record.changeType,
      record.status,
      record.userEdit,
      record.location,
      record.sourceUrl
    ]);
  }

  await redisSet(key, records, IMPL_TTL);
  return records;
}

function resolveSourceUrlFromLocation(location, baseUrl, crawledPages) {
  if (!location) return baseUrl || '';
  if (!baseUrl) return '';

  const locLower = location.toLowerCase().trim();

  // Clean location name: strip "page" from the end
  let locClean = locLower;
  if (locClean.endsWith(' page')) {
    locClean = locClean.slice(0, -5).trim();
  }
  if (locClean.endsWith(' of click trends')) {
    locClean = locClean.replace(' of click trends', '').trim();
  }

  if (locClean === 'home' || locClean === 'homepage' || locClean === '') {
    return baseUrl;
  }

  // Ensure crawledPages is an array
  const pages = Array.isArray(crawledPages) ? crawledPages : [];

  // 1. Try to find an exact or close match in crawledPages
  // Try exact match on URL path
  for (const page of pages) {
    if (!page.url) continue;
    try {
      const u = new URL(page.url);
      const pathClean = u.pathname.replace(/^\/|\/$/g, '').replace(/-/g, ' ').toLowerCase();
      if (pathClean === locClean) {
        return page.url;
      }
    } catch (_) {}
  }

  // Try matching page title contains locClean
  for (const page of pages) {
    if (!page.title) continue;
    const titleLower = page.title.toLowerCase();
    if (titleLower.includes(locClean)) {
      return page.url;
    }
  }

  // Try matching path contains/contained-in
  for (const page of pages) {
    if (!page.url) continue;
    try {
      const u = new URL(page.url);
      const pathClean = u.pathname.replace(/^\/|\/$/g, '').replace(/-/g, ' ').toLowerCase();
      if (pathClean.includes(locClean) || locClean.includes(pathClean)) {
        return page.url;
      }
    } catch (_) {}
  }

  // 2. Fallback: URL slug conversion
  // e.g. "about us" -> "about-us"
  const slug = locClean.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  try {
    const u = new URL(baseUrl);
    u.pathname = slug;
    return u.toString();
  } catch (_) {
    // Basic fallback string concatenation
    const baseClean = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    return baseClean + '/' + slug;
  }
}

export async function getImplementationChanges(auditId, pluginId) {
  const key = `impl_changes:${auditId}:${pluginId}`;
  let records = await redisGet(key);
  
  let needsResolution = false;
  if (records && records.length > 0) {
    for (const r of records) {
      if (!r.sourceUrl) {
        needsResolution = true;
        break;
      }
    }
  }

  if (!records || records.length === 0 || needsResolution) {
    const selectQuery = `SELECT * FROM implementation_changes WHERE audit_id = $1 AND plugin_id = $2;`;
    const { rows } = await pool.query(selectQuery, [auditId, pluginId]);
    if (rows.length > 0) {
      records = rows.map(row => ({
        id:             row.id,
        auditId:        row.audit_id,
        pluginId:       row.plugin_id,
        title:          row.title,
        priority:       row.priority,
        impactScore:    row.impact_score,
        description:    row.description,
        currentState:   row.current_state,
        proposedChange: row.proposed_change,
        changeType:     row.change_type,
        status:         row.status,
        userEdit:       row.user_edit,
        location:       row.location,
        sourceUrl:      row.source_url,
        createdAt:      row.created_at,
        updatedAt:      row.updated_at,
      }));
    }
  }

  if (records && records.length > 0) {
    let hasResolvedAny = false;
    const audit = await getAuditById(auditId);
    if (audit) {
      const baseUrl = audit.url;
      const crawledPages = audit.crawled_data?.pages || [];
      for (const r of records) {
        if (!r.sourceUrl) {
          r.sourceUrl = resolveSourceUrlFromLocation(r.location, baseUrl, crawledPages);
          hasResolvedAny = true;
          // Async update PostgreSQL so it's permanent
          pool.query(`UPDATE implementation_changes SET source_url = $1 WHERE id = $2;`, [r.sourceUrl, r.id]).catch(err => {
            console.error(`[queries] Error updating resolved source_url in DB:`, err);
          });
        }
      }
    }
    
    if (hasResolvedAny) {
      await redisSet(key, records, IMPL_TTL);
    }
  }

  return records || [];
}

export async function updateImplementationChange(auditId, pluginId, changeId, { status, userEdit }) {
  const key = `impl_changes:${auditId}:${pluginId}`;
  
  const updates = [];
  const params = [changeId];
  let paramCount = 2;
  if (status !== undefined) {
    updates.push(`status = $${paramCount}`);
    params.push(status);
    paramCount++;
  }
  if (userEdit !== undefined) {
    updates.push(`user_edit = $${paramCount}`);
    params.push(userEdit);
    paramCount++;
  }
  updates.push(`updated_at = NOW()`);

  const updateQuery = `
    UPDATE implementation_changes
    SET ${updates.join(', ')}
    WHERE id = $1
    RETURNING *;
  `;
  const { rows } = await pool.query(updateQuery, params);
  const row = rows[0];

  const records = (await redisGet(key)) || [];
  const idx = records.findIndex(r => r.id === changeId);
  if (idx !== -1) {
    if (status   !== undefined) records[idx].status   = status;
    if (userEdit !== undefined) records[idx].userEdit = userEdit;
    records[idx].updatedAt = new Date().toISOString();
    await redisSet(key, records, IMPL_TTL);
  }

  if (row) {
    let resolvedUrl = row.source_url;
    if (!resolvedUrl) {
      const audit = await getAuditById(auditId);
      if (audit) {
        resolvedUrl = resolveSourceUrlFromLocation(row.location, audit.url, audit.crawled_data?.pages || []);
      }
    }
    return {
      id:             row.id,
      auditId:        row.audit_id,
      pluginId:       row.plugin_id,
      title:          row.title,
      priority:       row.priority,
      impactScore:    row.impact_score,
      description:    row.description,
      currentState:   row.current_state,
      proposedChange: row.proposed_change,
      changeType:     row.change_type,
      status:         row.status,
      userEdit:       row.user_edit,
      location:       row.location,
      sourceUrl:      resolvedUrl,
      createdAt:      row.created_at,
      updatedAt:      row.updated_at,
    };
  }
  return idx !== -1 ? records[idx] : null;
}

/* Implementation Jobs */
export async function createImplementationJob(auditId, pluginId, approvedChanges) {
  const jobId = uuidv4();
  
  const insertQuery = `
    INSERT INTO implementation_jobs (id, audit_id, plugin_id, status, approved_changes, dispatched_at)
    VALUES ($1, $2, $3, 'queued', $4, NOW())
    RETURNING *;
  `;
  const { rows } = await pool.query(insertQuery, [jobId, auditId, pluginId, JSON.stringify(approvedChanges)]);
  const row = rows[0];

  const job = {
    id:              row.id,
    auditId:         row.audit_id,
    pluginId:        row.plugin_id,
    status:          row.status,
    approvedChanges: row.approved_changes,
    botResponse:     row.bot_response,
    dispatchedAt:    row.dispatched_at,
    completedAt:     row.completed_at,
  };

  const listKey = `impl_jobs:${auditId}`;
  const existing = (await redisGet(listKey)) || [];
  existing.push(job);
  await redisSet(listKey, existing, IMPL_TTL);
  await redisSet(`impl_job:${jobId}`, job, IMPL_TTL);
  return job;
}

export async function getImplementationJobs(auditId) {
  let jobs = await redisGet(`impl_jobs:${auditId}`);
  if (!jobs || jobs.length === 0) {
    const selectQuery = `SELECT * FROM implementation_jobs WHERE audit_id = $1 ORDER BY dispatched_at ASC;`;
    const { rows } = await pool.query(selectQuery, [auditId]);
    jobs = rows.map(row => ({
      id:              row.id,
      auditId:         row.audit_id,
      pluginId:        row.plugin_id,
      status:          row.status,
      approvedChanges: row.approved_changes,
      botResponse:     row.bot_response,
      dispatchedAt:    row.dispatched_at,
      completedAt:     row.completed_at,
    }));
    await redisSet(`impl_jobs:${auditId}`, jobs, IMPL_TTL);
  }
  return jobs || [];
}

export async function updateImplementationJob(jobId, updates) {
  const job = await redisGet(`impl_job:${jobId}`) || {};
  Object.assign(job, updates, { updatedAt: new Date().toISOString() });
  
  const dbUpdates = [];
  const dbParams = [jobId];
  let paramCount = 2;
  if (updates.status !== undefined) {
    dbUpdates.push(`status = $${paramCount}`);
    dbParams.push(updates.status);
    paramCount++;
  }
  if (updates.botResponse !== undefined) {
    dbUpdates.push(`bot_response = $${paramCount}`);
    dbParams.push(JSON.stringify(updates.botResponse));
    paramCount++;
  }
  if (updates.completedAt !== undefined) {
    dbUpdates.push(`completed_at = $${paramCount}`);
    dbParams.push(updates.completedAt);
    paramCount++;
  }
  dbUpdates.push(`updated_at = NOW()`);

  const updateQuery = `
    UPDATE implementation_jobs
    SET ${dbUpdates.join(', ')}
    WHERE id = $1
    RETURNING *;
  `;
  const { rows } = await pool.query(updateQuery, dbParams);
  const row = rows[0];

  if (row) {
    job.id = row.id;
    job.auditId = row.audit_id;
    job.pluginId = row.plugin_id;
    job.status = row.status;
    job.approvedChanges = row.approved_changes;
    job.botResponse = row.bot_response;
    job.dispatchedAt = row.dispatched_at;
    job.completedAt = row.completed_at;
  }

  await redisSet(`impl_job:${jobId}`, job, IMPL_TTL);
  const listKey = `impl_jobs:${job.auditId}`;
  const list = (await redisGet(listKey)) || [];
  const idx = list.findIndex(j => j.id === jobId);
  if (idx !== -1) { 
    list[idx] = job; 
    await redisSet(listKey, list, IMPL_TTL); 
  }
  return job;
}

// ─── PostgreSQL Integrations & Deployments (Multi-Tenant & Encrypted) ───

export async function getIntegrations(businessId) {
  const query = `
    SELECT id, business_id, platform, account_name, account_id, status, token_expiry, metadata, created_at, updated_at
    FROM business_integrations
    WHERE business_id = $1
    ORDER BY platform ASC;
  `;
  try {
    const { rows } = await pool.query(query, [businessId]);
    return rows;
  } catch (err) {
    console.error('[PostgreSQL] getIntegrations error:', err);
    return [];
  }
}

export async function getIntegrationByPlatform(businessId, platform) {
  const query = `
    SELECT * FROM business_integrations
    WHERE business_id = $1 AND platform = $2
    LIMIT 1;
  `;
  try {
    const { rows } = await pool.query(query, [businessId, platform]);
    const integration = rows[0];
    if (integration) {
      // Decrypt tokens for backend use
      integration.access_token = decryptToken(integration.access_token);
      integration.refresh_token = decryptToken(integration.refresh_token);
    }
    return integration || null;
  } catch (err) {
    console.error('[PostgreSQL] getIntegrationByPlatform error:', err);
    return null;
  }
}

export async function upsertIntegration({ businessId, platform, accountName, accountId, accessToken, refreshToken, tokenExpiry, status, metadata }) {
  const encAccess = encryptToken(accessToken);
  const encRefresh = encryptToken(refreshToken);

  const query = `
    INSERT INTO business_integrations (business_id, platform, account_name, account_id, access_token, refresh_token, token_expiry, status, metadata, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    ON CONFLICT (business_id, platform) DO UPDATE
    SET account_name = EXCLUDED.account_name,
        account_id = EXCLUDED.account_id,
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        token_expiry = EXCLUDED.token_expiry,
        status = EXCLUDED.status,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
    RETURNING *;
  `;
  try {
    const { rows } = await pool.query(query, [
      businessId,
      platform.toLowerCase(),
      accountName,
      accountId,
      encAccess,
      encRefresh,
      tokenExpiry,
      status || 'connected',
      metadata ? JSON.stringify(metadata) : null
    ]);
    const integration = rows[0];
    if (integration) {
      delete integration.access_token;
      delete integration.refresh_token;
    }
    return integration;
  } catch (err) {
    console.error('[PostgreSQL] upsertIntegration error:', err);
    throw err;
  }
}

export async function deleteIntegration(businessId, platform) {
  const query = `
    DELETE FROM business_integrations
    WHERE business_id = $1 AND platform = $2
    RETURNING *;
  `;
  try {
    const { rows } = await pool.query(query, [businessId, platform]);
    const integration = rows[0];
    if (integration) {
      delete integration.access_token;
      delete integration.refresh_token;
    }
    return integration || null;
  } catch (err) {
    console.error('[PostgreSQL] deleteIntegration error:', err);
    throw err;
  }
}

export async function updateIntegrationStatus(id, status) {
  const query = `
    UPDATE business_integrations
    SET status = $2, updated_at = NOW()
    WHERE id = $1
    RETURNING *;
  `;
  try {
    const { rows } = await pool.query(query, [id, status]);
    return rows[0] || null;
  } catch (err) {
    console.error('[PostgreSQL] updateIntegrationStatus error:', err);
    throw err;
  }
}

// ─── Deployment Jobs & Deployments (PostgreSQL) ──────────────

export async function createDbDeploymentJob({ businessId, auditId, changeId, platform, assetType }) {
  const query = `
    INSERT INTO deployment_jobs (business_id, audit_id, change_id, platform, asset_type, status)
    VALUES ($1, $2, $3, $4, $5, 'queued')
    RETURNING *;
  `;
  try {
    const { rows } = await pool.query(query, [businessId, auditId, changeId, platform, assetType]);
    return rows[0];
  } catch (err) {
    console.error('[PostgreSQL] createDbDeploymentJob error:', err);
    throw err;
  }
}

export async function getDbDeploymentJob(jobId) {
  const query = `SELECT * FROM deployment_jobs WHERE id = $1;`;
  try {
    const { rows } = await pool.query(query, [jobId]);
    return rows[0] || null;
  } catch (err) {
    console.error('[PostgreSQL] getDbDeploymentJob error:', err);
    return null;
  }
}

export async function updateDbDeploymentJob(jobId, status) {
  const query = `
    UPDATE deployment_jobs
    SET status = $2, updated_at = NOW()
    WHERE id = $1
    RETURNING *;
  `;
  try {
    const { rows } = await pool.query(query, [jobId, status]);
    return rows[0] || null;
  } catch (err) {
    console.error('[PostgreSQL] updateDbDeploymentJob error:', err);
    throw err;
  }
}

export async function createDeployment({ businessId, auditId, changeId, platform, assetType, contentPayload, previousContent, status, deployedBy, response }) {
  const query = `
    INSERT INTO deployments (business_id, audit_id, change_id, platform, asset_type, content_payload, previous_content, status, deployed_by, response)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *;
  `;
  try {
    const { rows } = await pool.query(query, [
      businessId,
      auditId,
      changeId,
      platform,
      assetType,
      JSON.stringify(contentPayload),
      previousContent ? JSON.stringify(previousContent) : null,
      status,
      deployedBy,
      response ? JSON.stringify(response) : null
    ]);
    return rows[0];
  } catch (err) {
    console.error('[PostgreSQL] createDeployment error:', err);
    throw err;
  }
}

export async function getDeployments(businessId) {
  const query = `
    SELECT * FROM deployments
    WHERE business_id = $1
    ORDER BY created_at DESC;
  `;
  try {
    const { rows } = await pool.query(query, [businessId]);
    return rows;
  } catch (err) {
    console.error('[PostgreSQL] getDeployments error:', err);
    return [];
  }
}

export async function getDeploymentById(id) {
  const query = `SELECT * FROM deployments WHERE id = $1;`;
  try {
    const { rows } = await pool.query(query, [id]);
    return rows[0] || null;
  } catch (err) {
    console.error('[PostgreSQL] getDeploymentById error:', err);
    return null;
  }
}

export async function getLatestDeployment(businessId, platform, changeId) {
  const query = `
    SELECT * FROM deployments
    WHERE business_id = $1 AND platform = $2 AND change_id = $3 AND status = 'completed'
    ORDER BY created_at DESC
    LIMIT 1;
  `;
  try {
    const { rows } = await pool.query(query, [businessId, platform, changeId]);
    return rows[0] || null;
  } catch (err) {
    console.error('[PostgreSQL] getLatestDeployment error:', err);
    return null;
  }
}

// ─── Audit Trail (PostgreSQL) ───────────────────────────────

export async function createAuditTrailEntry({ businessId, eventType, auditId, pluginId, changeId, actionDetails, performedBy, metadata }) {
  const query = `
    INSERT INTO audit_trail (business_id, event_type, audit_id, plugin_id, change_id, action_details, performed_by, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *;
  `;
  try {
    const { rows } = await pool.query(query, [
      businessId,
      eventType,
      auditId,
      pluginId,
      changeId,
      actionDetails,
      performedBy,
      metadata ? JSON.stringify(metadata) : null
    ]);
    return rows[0];
  } catch (err) {
    console.error('[PostgreSQL] createAuditTrailEntry error:', err);
    throw err;
  }
}

export async function getAuditTrail(businessId) {
  const query = `
    SELECT * FROM audit_trail
    WHERE business_id = $1
    ORDER BY timestamp DESC;
  `;
  try {
    const { rows } = await pool.query(query, [businessId]);
    return rows;
  } catch (err) {
    console.error('[PostgreSQL] getAuditTrail error:', err);
    return [];
  }
}

