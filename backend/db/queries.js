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

function ensureAbsoluteUrl(url, defaultBase = '') {
  if (!url) return '';
  let cleanUrl = url.trim();
  if (!/^https?:\/\//i.test(cleanUrl)) {
    if (cleanUrl.startsWith('/')) {
      const baseClean = defaultBase.endsWith('/') ? defaultBase.slice(0, -1) : defaultBase;
      return ensureAbsoluteUrl(baseClean + cleanUrl);
    }
    return 'https://' + cleanUrl;
  }
  return cleanUrl;
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

  if (locClean === 'home' || locClean === 'homepage' || locClean === 'homepage meta title' || locClean === 'homepage h1' || locClean === '') {
    return baseUrl;
  }

  // Ensure crawledPages is an array
  const pages = Array.isArray(crawledPages) ? crawledPages : [];

  // 1. Try to find an exact match on path
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

  // 2. Try matching page title contains locClean
  for (const page of pages) {
    if (!page.title) continue;
    const titleLower = page.title.toLowerCase();
    if (titleLower.includes(locClean) || locClean.includes(titleLower)) {
      return page.url;
    }
  }

  // 3. Try matching path contains/contained-in
  for (const page of pages) {
    if (!page.url) continue;
    try {
      const u = new URL(page.url);
      const pathClean = u.pathname.replace(/^\/|\/$/g, '').replace(/-/g, ' ').toLowerCase();
      if (pathClean.length > 3 && (locClean.includes(pathClean) || pathClean.includes(locClean))) {
        return page.url;
      }
    } catch (_) {}
  }

  // 4. Token-based matching (for titles/descriptions fallback)
  let bestMatchPage = null;
  let maxScore = 0;

  const locTokens = locClean.split(/[^a-z0-9]+/);
  
  for (const page of pages) {
    let score = 0;
    if (page.url) {
      try {
        const u = new URL(page.url);
        const pathTokens = u.pathname.replace(/^\/|\/$/g, '').split(/[^a-z0-9]+/);
        for (const token of pathTokens) {
          if (token.length > 3 && locTokens.includes(token)) {
            score += 2; // path match gets higher weight
          }
        }
      } catch (_) {}
    }
    if (page.title) {
      const titleTokens = page.title.toLowerCase().split(/[^a-z0-9]+/);
      for (const token of titleTokens) {
        if (token.length > 3 && locTokens.includes(token)) {
          score += 1;
        }
      }
    }

    if (score > maxScore) {
      maxScore = score;
      bestMatchPage = page.url;
    }
  }

  if (maxScore > 0 && bestMatchPage) {
    return bestMatchPage;
  }

  // 5. Fallback: URL slug conversion
  const slug = locClean.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  try {
    const u = new URL(baseUrl);
    u.pathname = slug;
    return u.toString();
  } catch (_) {
    const baseClean = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    return baseClean + '/' + slug;
  }
}

function isGeneralizedUrl(sourceUrl, baseUrl, location, title) {
  if (!sourceUrl || !baseUrl) return true; // if empty, it needs resolution

  const cleanSource = sourceUrl.trim().replace(/\/$/, '').toLowerCase();
  const cleanBase = baseUrl.trim().replace(/\/$/, '').toLowerCase();

  // If the source URL is not just the base URL, it is specific (not generalized)
  if (cleanSource !== cleanBase) {
    return false;
  }

  // If the source URL is the base URL, check if the change actually belongs to the homepage.
  // If location or title contains homepage terms, then it is NOT generalized (it's correctly pointing to homepage).
  const lookupTerm = (location || title || '').toLowerCase();
  if (lookupTerm.includes('home') || lookupTerm.includes('index') || lookupTerm.trim() === '') {
    return false;
  }

  // Otherwise, it is pointing to the base URL but the change belongs to a subpage -> it is generalized!
  return true;
}

export async function getImplementationChanges(auditId, pluginId) {
  const key = `impl_changes:${auditId}:${pluginId}`;
  let records = await redisGet(key);
  
  const audit = await getAuditById(auditId);
  const baseUrl = audit ? audit.url : '';
  
  let needsResolution = false;
  if (records && records.length > 0) {
    for (const r of records) {
      if (isGeneralizedUrl(r.sourceUrl, baseUrl, r.location, r.title)) {
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

  if (records && records.length > 0 && audit) {
    let hasResolvedAny = false;
    let crawledData = audit.crawled_data;
    if (typeof crawledData === 'string') {
      try {
        crawledData = JSON.parse(crawledData);
      } catch (_) {}
    }
    const crawledPages = crawledData?.pages || [];
    for (const r of records) {
      if (isGeneralizedUrl(r.sourceUrl, baseUrl, r.location, r.title)) {
        const lookupTerm = r.location || r.title || '';
        const resolved = resolveSourceUrlFromLocation(lookupTerm, baseUrl, crawledPages);
        r.sourceUrl = ensureAbsoluteUrl(resolved, baseUrl);
        hasResolvedAny = true;
        pool.query(`UPDATE implementation_changes SET source_url = $1 WHERE id = $2;`, [r.sourceUrl, r.id]).catch(err => {
          console.error(`[queries] Error updating resolved source_url in DB:`, err);
        });
      } else {
        const absolute = ensureAbsoluteUrl(r.sourceUrl, baseUrl);
        if (absolute !== r.sourceUrl) {
          r.sourceUrl = absolute;
          hasResolvedAny = true;
          pool.query(`UPDATE implementation_changes SET source_url = $1 WHERE id = $2;`, [r.sourceUrl, r.id]).catch(err => {
            console.error(`[queries] Error updating absolute source_url in DB:`, err);
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

export async function updateImplementationChange(auditId, pluginId, changeId, { status, userEdit, currentState }) {
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
  if (currentState !== undefined) {
    updates.push(`current_state = $${paramCount}`);
    params.push(currentState);
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
    if (currentState !== undefined) records[idx].currentState = currentState;
    records[idx].updatedAt = new Date().toISOString();
    await redisSet(key, records, IMPL_TTL);
  }

  if (row) {
    let resolvedUrl = row.source_url;
    const audit = await getAuditById(auditId);
    const baseUrl = audit ? audit.url : '';
    
    if (isGeneralizedUrl(resolvedUrl, baseUrl, row.location, row.title)) {
      if (audit) {
        let crawledData = audit.crawled_data;
        if (typeof crawledData === 'string') {
          try {
            crawledData = JSON.parse(crawledData);
          } catch (_) {}
        }
        const lookupTerm = row.location || row.title || '';
        resolvedUrl = resolveSourceUrlFromLocation(lookupTerm, baseUrl, crawledData?.pages || []);
      }
    }
    resolvedUrl = ensureAbsoluteUrl(resolvedUrl, baseUrl);
    
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

export async function createDeployment({ businessId, auditId, changeId, platform, assetType, contentPayload, previousContent, builderType, deploymentMethod, status, deployedBy, response }) {
  try {
    const insertQuery = `
      INSERT INTO deployments (business_id, audit_id, change_id, platform, asset_type, content_payload, previous_content, builder_type, deployment_method, status, deployed_by, response)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *;
    `;
    const { rows } = await pool.query(insertQuery, [
      businessId, 
      auditId, 
      changeId, 
      platform, 
      assetType,
      JSON.stringify(contentPayload),
      previousContent ? JSON.stringify(previousContent) : null,
      builderType || null,
      deploymentMethod || null,
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

/* Sub-service Pages CRUD helpers */
export async function saveSubServicePage(auditId, slug, { serviceName, subServiceName, pageTitle, metaDescription, status, contentJson, renderedHtml, templateId, pageId, generatedElementorData, builderType }) {
  const query = `
    INSERT INTO sub_service_pages (audit_id, slug, service_name, sub_service_name, page_title, meta_description, status, content_json, rendered_html, template_id, page_id, generated_elementor_data, builder_type, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
    ON CONFLICT (audit_id, slug) DO UPDATE
    SET service_name = EXCLUDED.service_name,
        sub_service_name = EXCLUDED.sub_service_name,
        page_title = EXCLUDED.page_title,
        meta_description = EXCLUDED.meta_description,
        status = EXCLUDED.status,
        content_json = EXCLUDED.content_json,
        rendered_html = EXCLUDED.rendered_html,
        template_id = EXCLUDED.template_id,
        page_id = EXCLUDED.page_id,
        generated_elementor_data = EXCLUDED.generated_elementor_data,
        builder_type = EXCLUDED.builder_type,
        updated_at = NOW()
    RETURNING *;
  `;
  try {
    const { rows } = await pool.query(query, [
      auditId,
      slug,
      serviceName,
      subServiceName,
      pageTitle,
      metaDescription,
      status || 'pending',
      contentJson ? JSON.stringify(contentJson) : null,
      renderedHtml,
      templateId,
      pageId,
      generatedElementorData ? JSON.stringify(generatedElementorData) : null,
      builderType
    ]);
    
    // Sync to Redis
    const stateKey = `sub_service_page:${auditId}:${slug}`;
    const redisPayload = {
      auditId,
      slug,
      serviceName,
      subServiceName,
      pageTitle,
      metaDescription,
      status: status || 'pending',
      generatedHtml: renderedHtml,
      contentJson,
      templateId,
      pageId,
      generatedElementorData,
      builderType,
      updatedAt: new Date().toISOString()
    };
    await redisClient.setEx(stateKey, IMPL_TTL, JSON.stringify(redisPayload));
    return rows[0];
  } catch (err) {
    console.error('[PostgreSQL] saveSubServicePage error:', err);
    throw err;
  }
}

export async function getSubServicePage(auditId, slug) {
  const query = `SELECT * FROM sub_service_pages WHERE audit_id = $1 AND slug = $2 LIMIT 1;`;
  try {
    const { rows } = await pool.query(query, [auditId, slug]);
    const row = rows[0];
    if (row) {
      return {
        auditId: row.audit_id,
        slug: row.slug,
        serviceName: row.service_name,
        subServiceName: row.sub_service_name,
        pageTitle: row.page_title,
        metaDescription: row.meta_description,
        status: row.status,
        contentJson: typeof row.content_json === 'string' ? JSON.parse(row.content_json) : row.content_json,
        renderedHtml: row.rendered_html,
        templateId: row.template_id,
        pageId: row.page_id,
        draftUrl: row.draft_url,
        generatedElementorData: typeof row.generated_elementor_data === 'string' ? JSON.parse(row.generated_elementor_data) : row.generated_elementor_data,
        builderType: row.builder_type,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    }
    
    // Fallback to Redis
    const stateKey = `sub_service_page:${auditId}:${slug}`;
    const cached = await redisClient.get(stateKey).then(v => v ? JSON.parse(v) : null).catch(() => null);
    if (cached) {
      return {
        auditId,
        slug,
        serviceName: cached.serviceName,
        subServiceName: cached.subServiceName,
        pageTitle: cached.pageTitle,
        metaDescription: cached.metaDescription,
        status: cached.status || 'pending',
        contentJson: cached.contentJson,
        renderedHtml: cached.generatedHtml || cached.html,
        templateId: cached.templateId,
        pageId: cached.pageId,
        draftUrl: cached.draftUrl,
        generatedElementorData: cached.generatedElementorData,
        builderType: cached.builderType,
        updatedAt: cached.updatedAt
      };
    }
    return null;
  } catch (err) {
    console.error('[PostgreSQL] getSubServicePage error:', err);
    return null;
  }
}

export async function approveSubServicePage(auditId, slug, status, { pageTitle, metaDescription, renderedHtml, draftUrl }) {
  const updates = ['status = $3', 'updated_at = NOW()'];
  const params = [auditId, slug, status];
  let paramCount = 4;
  
  if (pageTitle !== undefined) {
    updates.push(`page_title = $${paramCount}`);
    params.push(pageTitle);
    paramCount++;
  }
  if (metaDescription !== undefined) {
    updates.push(`meta_description = $${paramCount}`);
    params.push(metaDescription);
    paramCount++;
  }
  if (renderedHtml !== undefined) {
    updates.push(`rendered_html = $${paramCount}`);
    params.push(renderedHtml);
    paramCount++;
  }
  if (draftUrl !== undefined) {
    updates.push(`draft_url = $${paramCount}`);
    params.push(draftUrl);
    paramCount++;
  }
  
  const query = `
    UPDATE sub_service_pages
    SET ${updates.join(', ')}
    WHERE audit_id = $1 AND slug = $2
    RETURNING *;
  `;
  try {
    const { rows } = await pool.query(query, params);
    
    // Sync to Redis
    const stateKey = `sub_service_page:${auditId}:${slug}`;
    const existing = await redisClient.get(stateKey).then(v => v ? JSON.parse(v) : {}).catch(() => ({}));
    const updatedState = {
      ...existing,
      status,
      pageTitle: pageTitle || existing.pageTitle || null,
      metaDescription: metaDescription || existing.metaDescription || null,
      generatedHtml: renderedHtml || existing.generatedHtml || existing.html || null,
      draftUrl: draftUrl !== undefined ? draftUrl : existing.draftUrl,
      slug,
      updatedAt: new Date().toISOString()
    };
    await redisClient.setEx(stateKey, IMPL_TTL, JSON.stringify(updatedState));
    
    return rows[0] || updatedState;
  } catch (err) {
    console.error('[PostgreSQL] approveSubServicePage error:', err);
    throw err;
  }
}

/* ─── Page Design Templates ────────────────────────────────────────────────── */

/**
 * Save (or overwrite) the cleaned HTML design template for a service category.
 * Called on-demand the first time a page is generated for that service category.
 */
export async function savePageTemplate(auditId, serviceName, { templateId, builderType, sourceUrl, cleanedHtml, sectionConfiguration, masterElementorData, elementorPageSettings, fetchStatus = 'captured' }) {
  const query = `
    INSERT INTO page_templates (audit_id, service_name, template_id, builder_type, source_url, cleaned_html, section_configuration, master_elementor_data, elementor_page_settings, fetch_status, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
    ON CONFLICT (audit_id, service_name) DO UPDATE
    SET template_id = EXCLUDED.template_id,
        builder_type = EXCLUDED.builder_type,
        source_url   = EXCLUDED.source_url,
        cleaned_html = EXCLUDED.cleaned_html,
        section_configuration = EXCLUDED.section_configuration,
        master_elementor_data = EXCLUDED.master_elementor_data,
        elementor_page_settings = EXCLUDED.elementor_page_settings,
        fetch_status = EXCLUDED.fetch_status,
        updated_at   = NOW()
    RETURNING id, captured_at, updated_at;
  `;
  try {
    const { rows } = await pool.query(query, [auditId, serviceName, templateId, builderType, sourceUrl, cleanedHtml, sectionConfiguration ? JSON.stringify(sectionConfiguration) : null, masterElementorData ? JSON.stringify(masterElementorData) : null, elementorPageSettings ? JSON.stringify(elementorPageSettings) : null, fetchStatus]);
    const cacheKey = `page_template:${auditId}:${serviceName}`;
    const payload = { auditId, serviceName, templateId, builderType, sourceUrl, cleanedHtml, sectionConfiguration, masterElementorData, elementorPageSettings, fetchStatus, capturedAt: rows[0]?.captured_at };
    await redisClient.setEx(cacheKey, IMPL_TTL, JSON.stringify(payload));
    return rows[0];
  } catch (err) {
    console.error('[PostgreSQL] savePageTemplate error:', err);
    throw err;
  }
}

/**
 * Retrieve the stored design template for a service category.
 * Returns { sourceUrl, cleanedHtml, fetchStatus, capturedAt } or null.
 */
export async function getPageTemplate(auditId, serviceName) {
  const cacheKey = `page_template:${auditId}:${serviceName}`;
  try {
    const cached = await redisClient.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (_) {}

  try {
    const { rows } = await pool.query(
      `SELECT template_id, builder_type, source_url, cleaned_html, section_configuration, master_elementor_data, elementor_page_settings, fetch_status, captured_at
       FROM page_templates WHERE audit_id = $1 AND service_name = $2 LIMIT 1;`,
      [auditId, serviceName]
    );
    if (!rows[0]) return null;
    const result = {
      auditId,
      serviceName,
      templateId:  rows[0].template_id,
      builderType: rows[0].builder_type,
      sourceUrl:   rows[0].source_url,
      cleanedHtml: rows[0].cleaned_html,
      sectionConfiguration: typeof rows[0].section_configuration === 'string' ? JSON.parse(rows[0].section_configuration) : rows[0].section_configuration,
      masterElementorData: typeof rows[0].master_elementor_data === 'string' ? JSON.parse(rows[0].master_elementor_data) : rows[0].master_elementor_data,
      elementorPageSettings: typeof rows[0].elementor_page_settings === 'string' ? JSON.parse(rows[0].elementor_page_settings) : rows[0].elementor_page_settings,
      fetchStatus: rows[0].fetch_status,
      capturedAt:  rows[0].captured_at,
    };
    await redisClient.setEx(cacheKey, IMPL_TTL, JSON.stringify(result));
    return result;
  } catch (err) {
    console.error('[PostgreSQL] getPageTemplate error:', err);
    return null;
  }
}

/**
 * Returns true if a design template already exists for this audit + service category.
 */
export async function hasPageTemplate(auditId, serviceName) {
  const existing = await getPageTemplate(auditId, serviceName);
  return !!existing;
}

// ════════════════════════════════════════════════════════════════
// ADMIN PANEL QUERIES (platform-wide; PostgreSQL source of truth)
// All callers are gated by requireAdminAPI in routes/admin.js.
// ════════════════════════════════════════════════════════════════

const USER_SORT_COLUMNS = {
  email: 'u.email', full_name: 'u.full_name', role: 'u.role', status: 'u.status',
  plan: 'u.plan', created_at: 'u.created_at', last_login_at: 'u.last_login_at',
  report_count: 'report_count',
};

/* ─── Users ─────────────────────────────────────────────────── */
export async function listUsers({ search = '', role = '', status = '', sort = 'created_at', dir = 'desc' } = {}) {
  const where = ['u.deleted_at IS NULL'];
  const params = [];
  if (search) { params.push(`%${search.toLowerCase()}%`); where.push(`(LOWER(u.email) LIKE $${params.length} OR LOWER(COALESCE(u.full_name,'')) LIKE $${params.length})`); }
  if (role)   { params.push(role); where.push(`u.role = $${params.length}`); }
  if (status) { params.push(status); where.push(`u.status = $${params.length}`); }

  const sortCol = USER_SORT_COLUMNS[sort] || 'u.created_at';
  const sortDir = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const query = `
    SELECT u.id, u.email, u.full_name, u.role, u.status, u.plan, u.created_at, u.last_login_at,
      (SELECT COUNT(*) FROM audits a WHERE a.user_id = u.id)::int AS report_count,
      (SELECT COUNT(*) FROM deployments d WHERE d.audit_id IN (SELECT a2.id::text FROM audits a2 WHERE a2.user_id = u.id))::int AS deployment_count
    FROM users u
    WHERE ${where.join(' AND ')}
    ORDER BY ${sortCol} ${sortDir} NULLS LAST;
  `;
  const { rows } = await pool.query(query, params);
  return rows;
}

export async function getUserDetail(userId) {
  const { rows } = await pool.query(
    `SELECT id, email, full_name, role, status, plan, metadata, created_at, updated_at, last_login_at
     FROM users WHERE id = $1 AND deleted_at IS NULL;`, [userId]);
  if (!rows[0]) return null;
  const user = rows[0];
  const auditsRes = await pool.query(
    `SELECT id, url, status, overall_score, created_at, completed_at FROM audits WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100;`, [userId]);
  user.audits = auditsRes.rows;
  user.report_count = auditsRes.rows.length;
  return user;
}

const USER_EDITABLE = ['email', 'full_name', 'role', 'status', 'plan', 'metadata'];
export async function updateUser(userId, fields) {
  const sets = [];
  const params = [userId];
  for (const key of USER_EDITABLE) {
    if (fields[key] !== undefined) {
      params.push(key === 'metadata' && typeof fields[key] !== 'string' ? JSON.stringify(fields[key]) : fields[key]);
      sets.push(`${key} = $${params.length}`);
    }
  }
  if (sets.length === 0) return getUserDetail(userId);
  sets.push('updated_at = NOW()');
  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING id;`, params);
  if (!rows[0]) return null;
  return getUserDetail(userId);
}

export async function setUserPassword(userId, passwordHash) {
  const { rows } = await pool.query(
    `UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1 RETURNING id, email;`, [userId, passwordHash]);
  return rows[0] || null;
}

export async function softDeleteUser(userId) {
  const { rows } = await pool.query(
    `UPDATE users SET deleted_at = NOW(), status = 'suspended', updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL RETURNING id, email;`, [userId]);
  return rows[0] || null;
}

export async function hardDeleteUser(userId) {
  const { rows } = await pool.query(`DELETE FROM users WHERE id = $1 RETURNING id, email;`, [userId]);
  return rows[0] || null;
}

// Count what a user delete would remove (for the confirm-with-preview modal).
export async function getUserDeletionImpact(userId) {
  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*) FROM audits WHERE user_id = $1)::int AS audits,
            (SELECT COUNT(*) FROM deployments d WHERE d.audit_id IN (SELECT id::text FROM audits WHERE user_id = $1))::int AS deployments;`,
    [userId]);
  return rows[0] || { audits: 0, deployments: 0 };
}

/* ─── Reports (audits) ──────────────────────────────────────── */
const AUDIT_SORT_COLUMNS = { created_at: 'a.created_at', url: 'a.url', status: 'a.status', overall_score: 'a.overall_score', email: 'u.email' };

export async function listAllAudits({ search = '', userId = '', status = '', pluginId = '', from = '', to = '', sort = 'created_at', dir = 'desc' } = {}) {
  const where = [];
  const params = [];
  if (search) { params.push(`%${search.toLowerCase()}%`); where.push(`(LOWER(a.url) LIKE $${params.length} OR LOWER(COALESCE(u.email,'')) LIKE $${params.length})`); }
  if (userId) { params.push(userId); where.push(`a.user_id = $${params.length}`); }
  if (status) { params.push(status); where.push(`a.status = $${params.length}`); }
  if (from)   { params.push(from); where.push(`a.created_at >= $${params.length}`); }
  if (to)     { params.push(to);   where.push(`a.created_at <= $${params.length}`); }
  if (pluginId) { params.push(pluginId); where.push(`EXISTS (SELECT 1 FROM audit_plugins ap WHERE ap.audit_id = a.id AND ap.plugin_id = $${params.length})`); }

  const sortCol = AUDIT_SORT_COLUMNS[sort] || 'a.created_at';
  const sortDir = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const query = `
    SELECT a.id, a.url, a.status, a.overall_score, a.created_at, a.completed_at,
      a.user_id, u.email AS user_email, u.full_name AS user_name,
      (SELECT array_agg(ap.plugin_id) FROM audit_plugins ap WHERE ap.audit_id = a.id) AS plugins,
      (SELECT COUNT(*) FROM implementation_changes c WHERE c.audit_id = a.id)::int AS change_count,
      (SELECT COUNT(*) FROM implementation_changes c WHERE c.audit_id = a.id AND c.status = 'approved')::int AS approved_count,
      (SELECT COUNT(*) FROM implementation_changes c WHERE c.audit_id = a.id AND c.status = 'rejected')::int AS rejected_count,
      (SELECT COUNT(*) FROM implementation_changes c WHERE c.audit_id = a.id AND c.status = 'pending')::int AS pending_count
    FROM audits a
    LEFT JOIN users u ON u.id = a.user_id
    ${whereClause}
    ORDER BY ${sortCol} ${sortDir} NULLS LAST
    LIMIT 500;
  `;
  const { rows } = await pool.query(query, params);
  return rows;
}

export async function getAuditFull(auditId) {
  const auditRes = await pool.query(
    `SELECT a.*, u.email AS user_email, u.full_name AS user_name
     FROM audits a LEFT JOIN users u ON u.id = a.user_id WHERE a.id = $1;`, [auditId]);
  if (!auditRes.rows[0]) return null;
  const audit = auditRes.rows[0];
  const [plugins, changes, deployments, trail] = await Promise.all([
    pool.query(`SELECT * FROM audit_plugins WHERE audit_id = $1;`, [auditId]).then(r => r.rows),
    pool.query(`SELECT * FROM implementation_changes WHERE audit_id = $1 ORDER BY created_at;`, [auditId]).then(r => r.rows),
    pool.query(`SELECT id, platform, asset_type, status, deployed_by, created_at FROM deployments WHERE audit_id = $1 ORDER BY created_at DESC;`, [String(auditId)]).then(r => r.rows).catch(() => []),
    pool.query(`SELECT * FROM audit_trail WHERE audit_id = $1 ORDER BY timestamp DESC;`, [String(auditId)]).then(r => r.rows).catch(() => []),
  ]);
  return { ...audit, plugins, changes, deployments, trail };
}

export async function deleteAudit(auditId) {
  const { rows } = await pool.query(`DELETE FROM audits WHERE id = $1 RETURNING id, url;`, [auditId]);
  // Clear Redis caches (best-effort).
  try { await redisClient.del(`audit:${auditId}`); await redisClient.del(`audit_plugins:${auditId}`); } catch (_) {}
  return rows[0] || null;
}

export async function reassignAudit(auditId, newUserId) {
  const { rows } = await pool.query(
    `UPDATE audits SET user_id = $2, updated_at = NOW() WHERE id = $1 RETURNING id, user_id;`, [auditId, newUserId]);
  try { await redisClient.del(`audit:${auditId}`); } catch (_) {}
  return rows[0] || null;
}

/* ─── Plugins (registry/metadata) ───────────────────────────── */
export async function listAllPlugins() {
  const query = `
    SELECT p.id, p.name, p.description, p.category, p.icon, p.prompt_template,
      p.display_order, p.is_active, p.is_executable, p.estimated_runtime_seconds, p.created_at, p.updated_at,
      (SELECT COUNT(*) FROM audit_plugins ap WHERE ap.plugin_id = p.id)::int AS run_count,
      (SELECT MAX(ap.started_at) FROM audit_plugins ap WHERE ap.plugin_id = p.id) AS last_run_at
    FROM plugins p
    ORDER BY p.display_order ASC, p.name ASC;
  `;
  const { rows } = await pool.query(query);
  return rows;
}

export async function getPluginById(id) {
  const { rows } = await pool.query(`SELECT * FROM plugins WHERE id = $1;`, [id]);
  return rows[0] || null;
}

// Insert a new registry plugin (is_executable defaults FALSE — no module yet).
export async function createPlugin({ id, name, description, category, icon, promptTemplate, isActive = true }) {
  const orderRes = await pool.query(`SELECT COALESCE(MAX(display_order), 0) + 1 AS next FROM plugins;`);
  const nextOrder = orderRes.rows[0].next;
  const { rows } = await pool.query(
    `INSERT INTO plugins (id, name, description, category, icon, prompt_template, display_order, is_active, is_executable, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, NOW())
     RETURNING *;`,
    [id, name, description || '', category || 'Other', icon || '🔌', promptTemplate || null, nextOrder, isActive]);
  return rows[0];
}

const PLUGIN_EDITABLE = { name: 'name', description: 'description', category: 'category', icon: 'icon', promptTemplate: 'prompt_template', isActive: 'is_active' };
export async function updatePlugin(id, fields) {
  const sets = [];
  const params = [id];
  for (const [key, col] of Object.entries(PLUGIN_EDITABLE)) {
    if (fields[key] !== undefined) { params.push(fields[key]); sets.push(`${col} = $${params.length}`); }
  }
  if (sets.length === 0) return getPluginById(id);
  sets.push('updated_at = NOW()');
  const { rows } = await pool.query(`UPDATE plugins SET ${sets.join(', ')} WHERE id = $1 RETURNING *;`, params);
  return rows[0] || null;
}

export async function togglePlugin(id, isActive) {
  const { rows } = await pool.query(
    `UPDATE plugins SET is_active = $2, updated_at = NOW() WHERE id = $1 RETURNING *;`, [id, isActive]);
  return rows[0] || null;
}

export async function deletePlugin(id) {
  const { rows } = await pool.query(`DELETE FROM plugins WHERE id = $1 RETURNING id, name;`, [id]);
  return rows[0] || null;
}

export async function getPluginUsageCount(id) {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM audit_plugins WHERE plugin_id = $1;`, [id]);
  return rows[0]?.count || 0;
}

// order = [{ id, display_order }, ...]
export async function reorderPlugins(order) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const { id, display_order } of order) {
      await client.query(`UPDATE plugins SET display_order = $2, updated_at = NOW() WHERE id = $1;`, [id, display_order]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return listAllPlugins();
}

/* ─── Audit Trail (platform-wide, paginated/filterable) ─────── */
export async function getAllAuditTrail({ search = '', user = '', eventType = '', auditId = '', from = '', to = '', limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (search)    { params.push(`%${search.toLowerCase()}%`); where.push(`LOWER(action_details) LIKE $${params.length}`); }
  if (user)      { params.push(`%${user.toLowerCase()}%`); where.push(`LOWER(performed_by) LIKE $${params.length}`); }
  if (eventType) { params.push(eventType); where.push(`event_type = $${params.length}`); }
  if (auditId)   { params.push(auditId); where.push(`audit_id = $${params.length}`); }
  if (from)      { params.push(from); where.push(`timestamp >= $${params.length}`); }
  if (to)        { params.push(to); where.push(`timestamp <= $${params.length}`); }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const countRes = await pool.query(`SELECT COUNT(*)::int AS total FROM audit_trail ${whereClause};`, params);
  const total = countRes.rows[0]?.total || 0;

  params.push(Math.min(Number(limit) || 50, 500));
  params.push(Number(offset) || 0);
  const { rows } = await pool.query(
    `SELECT * FROM audit_trail ${whereClause} ORDER BY timestamp DESC LIMIT $${params.length - 1} OFFSET $${params.length};`, params);
  return { rows, total };
}

// Distinct event types — for the audit-trail filter dropdown.
export async function getAuditTrailEventTypes() {
  const { rows } = await pool.query(`SELECT DISTINCT event_type FROM audit_trail ORDER BY event_type;`);
  return rows.map(r => r.event_type);
}

/* ─── Platform stats (dashboard) ────────────────────────────── */
export async function getPlatformStats() {
  const q = async (sql, params = []) => (await pool.query(sql, params)).rows[0];
  const [users, reports, plugins, deployments, failedJobs] = await Promise.all([
    q(`SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'active')::int AS active,
              COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS new_week
       FROM users WHERE deleted_at IS NULL`),
    q(`SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS week,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
       FROM audits`),
    q(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_active)::int AS enabled FROM plugins`),
    q(`SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS week
       FROM deployments`),
    q(`SELECT
              (SELECT COUNT(*) FROM deployments WHERE status = 'failed' AND created_at >= NOW() - INTERVAL '24 hours')::int AS deploys,
              (SELECT COUNT(*) FROM audits WHERE status = 'failed' AND updated_at >= NOW() - INTERVAL '24 hours')::int AS audits,
              (SELECT COUNT(*) FROM implementation_jobs WHERE status = 'failed' AND updated_at >= NOW() - INTERVAL '24 hours')::int AS jobs`),
  ]);
  return {
    users,
    reports,
    plugins,
    deployments,
    failedLast24h: (failedJobs.deploys || 0) + (failedJobs.audits || 0) + (failedJobs.jobs || 0),
  };
}

// Recent activity feed across all businesses/users (dashboard).
export async function getRecentActivity(limit = 20) {
  const { rows } = await pool.query(
    `SELECT id, event_type, action_details, performed_by, audit_id, plugin_id, timestamp, metadata
     FROM audit_trail ORDER BY timestamp DESC LIMIT $1;`, [Math.min(Number(limit) || 20, 100)]);
  return rows;
}

// Lookup a user by id including deleted (for impersonation issuing).
export async function getUserForImpersonation(userId) {
  const { rows } = await pool.query(
    `SELECT id, email, role, status FROM users WHERE id = $1 AND deleted_at IS NULL;`, [userId]);
  return rows[0] || null;
}

// Fetch an admin's password hash for re-auth (confirm-password gate).
export async function getUserPasswordHash(userId) {
  const { rows } = await pool.query(`SELECT password_hash FROM users WHERE id = $1;`, [userId]);
  return rows[0]?.password_hash || null;
}
