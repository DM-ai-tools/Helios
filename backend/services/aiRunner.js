// ============================================================
// backend/services/aiRunner.js
// AI executor — runs each plugin via Anthropic Claude API
// Uses claude-3-5-sonnet for plugins, claude-3-haiku for synthesis
// ============================================================

import Anthropic from '@anthropic-ai/sdk';

// Per-plugin API key map — read lazily inside getClient() after dotenv loads
const PLUGIN_KEY_VARS = {
  'brand-review':      'ANTHROPIC_API_KEY',   // key 1 (original)
  'campaign-plan':     'ANTHROPIC_API_KEY_2', // key 2
  'competitive-brief': 'ANTHROPIC_API_KEY_3', // key 3
  'content-copy':      'ANTHROPIC_API_KEY_4', // key 4
  'email-sequence':    'ANTHROPIC_API_KEY_5', // key 5
  'seo-audit':         'ANTHROPIC_API_KEY_6', // key 6
};

// Dedicated Anthropic client per plugin — lazy-initialised on first use
const _clients = {};
function getClient(pluginId) {
  if (_clients[pluginId]) return _clients[pluginId];

  // Read key lazily so dotenv has already populated process.env
  const envVar = PLUGIN_KEY_VARS[pluginId] || 'ANTHROPIC_API_KEY';
  const key    = process.env[envVar] || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error(`No ANTHROPIC_API_KEY configured for plugin "${pluginId}". Check .env`);

  console.log(`[Claude] Initialising client for plugin "${pluginId}" using ${envVar} (...${key.slice(-6)})`);
  _clients[pluginId] = new Anthropic({ apiKey: key });
  return _clients[pluginId];
}

// Synthesis uses the primary key (no dedicated key needed — runs once after all plugins)
let _synthesisClient = null;
function getSynthesisClient() {
  if (!_synthesisClient) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY is not set in .env');
    _synthesisClient = new Anthropic({ apiKey: key });
  }
  return _synthesisClient;
}

// Model selection — confirmed available on this Anthropic account
const PLUGIN_MODEL    = 'claude-sonnet-4-5-20250929'; // latest Sonnet, available on this key
const SYNTHESIS_MODEL = 'claude-sonnet-4-5-20250929'; // used for synthesis summary
const MAX_TOKENS      = 16384; // Supports up to 64k; 8192 was still truncating seo-audit/campaign-plan

// ─────────────────────────────────────────────────────────────
// slimCrawledData — Strips heavy page content before sending to
// Claude. Keeps only essential structured metadata per page so
// the combined prompt stays well under the 200k token limit.
// ─────────────────────────────────────────────────────────────
function slimCrawledData(crawledData) {
  // Tight limits — with 6 parallel calls these must stay small
  const CHAR_LIMIT   = 300;   // max chars per body excerpt
  const MAX_PAGES    = 8;     // max pages sent per plugin
  const MAX_PERPLX   = 3000;  // max chars per perplexity blob
  const MAX_ITEMS    = 10;    // max array items (links, headings, CTAs etc.)

  const slimPage = (p) => ({
    url:             (p.url             || '').slice(0, 200),
    statusCode:      p.statusCode,
    title:           (p.title           || '').slice(0, 100),
    metaDescription: (p.metaDescription || '').slice(0, 155),
    h1:              (p.h1              || '').slice(0, 100),
    h2s:             (p.h2s            || []).slice(0, 4).map(h => (h || '').slice(0, 80)),
    wordCount:       p.wordCount,
    hasSchema:       !!(p.schema && p.schema.length),
    bodyExcerpt:     (p.bodyText || p.content || p.text || '').slice(0, CHAR_LIMIT),
  });

  // ── WHITELIST ONLY: never spread the raw crawledData object ──────
  // The spread (...crawledData) was leaking rawHtml, fullPageContent,
  // and other huge fields straight into every plugin prompt → OOM crash.
  return {
    // Identity
    url:              crawledData.url,
    industry:         crawledData.industry,

    // Slimmed pages
    pages:            (crawledData.pages || []).slice(0, MAX_PAGES).map(slimPage),

    // Structured signals — already small scalars/short arrays
    businessSummary:  crawledData.businessSummary  || {},
    productsServices: (crawledData.productsServices || []).slice(0, MAX_ITEMS),
    contentTypes:     (crawledData.contentTypes    || []).slice(0, MAX_ITEMS),
    socialLinks:      (crawledData.socialLinks     || []).slice(0, MAX_ITEMS),
    geography:        crawledData.geography        || 'Australia',

    // SEO signals
    metaSignals:      crawledData.metaSignals      || {},
    onPageAudit:      crawledData.onPageAudit      || {},
    keywordStats:     crawledData.keywordStats     || {},
    keywordIdeas:     (crawledData.keywordIdeas    || []).slice(0, 20),

    // Page-level arrays — trimmed
    headings:         (crawledData.headings        || []).slice(0, MAX_ITEMS),
    ctaText:          (crawledData.ctaText         || []).slice(0, MAX_ITEMS),
    homepage:         crawledData.homepage         || {},
    aboutPage:        crawledData.aboutPage        || {},

    // Email-sequence specific fields — required by email-sequence buildUserPrompt
    // Without these the plugin has no capture context and produces empty sequences
    emailForms:       (crawledData.emailForms      || []).slice(0, MAX_ITEMS),
    leadMagnets:      (crawledData.leadMagnets     || []).slice(0, MAX_ITEMS),
    brandVoice:       crawledData.brandVoice       || null,

    // Perplexity research — hard-truncated
    perplexityBusiness:    crawledData.perplexityBusiness
      ? JSON.stringify(crawledData.perplexityBusiness   ).slice(0, MAX_PERPLX) : null,
    perplexityCompetitors: crawledData.perplexityCompetitors
      ? JSON.stringify(crawledData.perplexityCompetitors).slice(0, MAX_PERPLX) : null,
    perplexityIndustry:    crawledData.perplexityIndustry
      ? JSON.stringify(crawledData.perplexityIndustry   ).slice(0, MAX_PERPLX) : null,
  };
}

// ─────────────────────────────────────────────────────────────
// runPlugin — Calls Claude with one plugin's system+user prompt
// ─────────────────────────────────────────────────────────────
export async function runPlugin(plugin, crawledData, onProgress = () => {}) {
  onProgress(`Running ${plugin.name}…`);
  console.log(`[Claude] Starting plugin: ${plugin.id}`);

  // Slim the crawled data to avoid exceeding token limits
  const slimData = slimCrawledData(crawledData);
  let userPrompt = plugin.buildUserPrompt(slimData);

  // Hard prompt size guard — 30k chars ≈ ~7500 tokens, safe for 6 parallel calls
  const MAX_PROMPT_CHARS = 30_000;
  if (userPrompt.length > MAX_PROMPT_CHARS) {
    console.warn(`[Claude:${plugin.id}] User prompt too large (${userPrompt.length} chars) — truncating to ${MAX_PROMPT_CHARS}`);
    userPrompt = userPrompt.slice(0, MAX_PROMPT_CHARS) + '\n\n[Data truncated to fit context limit. Analyse what is available.]';
  }


  const systemPrompt = `${plugin.systemPrompt}

════════════════════════════════════════════════════════
SCORING RUBRIC (use this to calculate the score field)
════════════════════════════════════════════════════════
${plugin.scoringPrompt}

CRITICAL OUTPUT RULES:
1. YOUR RESPONSE MUST START WITH { AND END WITH } — no markdown fences, no prose.
2. Respond ONLY with raw, valid JSON — no code fences ('''json), no explanation.
3. The JSON root object MUST directly contain the keys matching this exact output format:
${JSON.stringify(plugin.outputFormat, null, 2)}
4. Every field in the outputFormat must be present in your response.
5. Do NOT wrap the output in any outer key (e.g. do not do {"result": {...}}).
6. Be thorough but concise to avoid truncation.
7. CRITICAL JSON ESCAPING: All string values must be on ONE line. Use \\n for line breaks inside strings — NEVER actual newlines inside a JSON string. Escape all quotes inside strings as \\".`;

  try {
    const anthropic = getClient(plugin.id);

    // ── Prompt inspection log ─────────────────────────────────
    console.log(`[Claude:${plugin.id}] ── Sending prompt to ${PLUGIN_MODEL} ──`);
    console.log(`[Claude:${plugin.id}]   system prompt : ${systemPrompt.length} chars`);
    console.log(`[Claude:${plugin.id}]   user prompt   : ${userPrompt.length} chars`);
    console.log(`[Claude:${plugin.id}]   max_tokens    : ${plugin.maxTokens || MAX_TOKENS}`);
    console.log(`[Claude:${plugin.id}]   system preview: ${systemPrompt.slice(0, 120).replace(/\n/g, ' ')}…`);
    console.log(`[Claude:${plugin.id}]   user preview  : ${userPrompt.slice(0, 120).replace(/\n/g, ' ')}…`);
    // ─────────────────────────────────────────────────────────

    // Assistant prefill: seeding '{' forces Claude to output raw JSON immediately
    // — no markdown fences, no preamble, guaranteed to start with valid JSON
    const message = await anthropic.messages.create({
      model:      PLUGIN_MODEL,
      max_tokens: plugin.maxTokens || MAX_TOKENS,
      system:     systemPrompt,
      messages:   [
        { role: 'user',      content: userPrompt },
        { role: 'assistant', content: '{'        },   // prefill — Claude continues from here
      ],
    });

    const stopReason = message.stop_reason;
    // Prepend the '{' we seeded in the prefill — Claude's response is the continuation
    const rawOutput  = '{' + (message.content[0]?.text || '');
    const inputTok   = message.usage?.input_tokens  || 0;
    const outputTok  = message.usage?.output_tokens || 0;

    console.log(`[Claude] Plugin ${plugin.id}: stop_reason=${stopReason} | tokens=${inputTok}in/${outputTok}out`);

    if (!rawOutput) {
      // Empty response — model produced nothing (safety / glitch)
      console.warn(`[Claude] Plugin ${plugin.id}: empty output. stop_reason=${stopReason}`);
      throw new Error(`Model returned empty output (stop_reason=${stopReason})`);
    }

    onProgress(`${plugin.name} — parsing response…`);

    const parsed = parseJSON(rawOutput, plugin.id);

    const score = typeof parsed.score === 'number' ? parsed.score : 0;
    console.log(`[Claude] ✓ Plugin ${plugin.id} complete. Score: ${score}`);
    onProgress(`${plugin.name} complete — score: ${score}/100`);

    return {
      output: parsed,
      score,
      summary:         parsed.summary || '',
      recommendations: parsed.recommendations || [],
      tokensUsed: inputTok + outputTok,
    };

  } catch (err) {
    console.error(`[Claude] Plugin ${plugin.id} failed: ${err.message}`);
    onProgress(`${plugin.name} — encountered an error, continuing…`);
    return {
      output: null,
      score: 0,
      summary: `Analysis failed: ${err.message}`,
      recommendations: [],
      error: err.message,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// runAllPlugins — Runs ALL plugins in PARALLEL, each with its
// own dedicated Anthropic API key, so the total wait time equals
// the slowest single plugin instead of the sum of all of them.
// SSE events still fire individually as each plugin completes.
// ─────────────────────────────────────────────────────────────
export async function runAllPlugins(
  plugins,
  crawledData,
  onProgress       = () => {},
  onPluginComplete = () => {}
) {
  console.log(`[Claude] Running ${plugins.length} plugins IN PARALLEL (one key each)`);

  // Fire all plugins at once — each gets its own API key
  const promises = plugins.map(plugin => {
    onProgress(`Running ${plugin.name}…`);
    return runPlugin(plugin, crawledData, onProgress)
      .then(res => {
        // SSE fires as soon as THIS plugin finishes (not waiting for others)
        onPluginComplete({ pluginId: plugin.id, pluginName: plugin.name, ...res });
        return {
          pluginId:   plugin.id,
          pluginName: plugin.name,
          weight:     plugin.weight || (1 / plugins.length),
          ...res,
        };
      });
  });

  // Wait for all to complete (order may vary — that's fine)
  const results = await Promise.all(promises);
  console.log(`[Claude] All ${results.length} plugins complete`);
  return results;
}

// ─────────────────────────────────────────────────────────────
// generateSynthesis — Claude writes the executive summary from
// all plugin outputs combined
// ─────────────────────────────────────────────────────────────
export async function generateSynthesis(pluginResults, crawledData, overallScore) {
  console.log(`[Claude] Generating synthesis report…`);

  // Build a rich plugin summary to pass to Claude
  const pluginSummaries = pluginResults
    .filter(r => r.output)
    .map(r => {
      const recs = (r.recommendations || [])
        .slice(0, 3)
        .map(rec => {
          if (typeof rec === 'string') return `  - ${rec}`;
          return `  - [${rec.effort || 'Action'}] ${rec.action || rec.title || rec}`;
        }).join('\n');
      return `## ${r.pluginName} (Score: ${r.score}/100)\n${r.summary}\nTop recommendations:\n${recs}`;
    })
    .join('\n\n---\n\n');

  const systemPrompt = `You are a senior marketing strategist writing an executive summary for a business audit report.
You have received detailed analysis from multiple AI modules. Your task is to synthesise these into a cohesive,
commercially useful executive summary that a business owner can immediately act on.

Write in Australian English. Be direct, specific, and avoid generic advice.
Reference specific findings from the plugin analyses provided.

CRITICAL OUTPUT RULES:
1. Respond ONLY with raw, valid JSON — no markdown, no prose, no explanation.
2. The root JSON object MUST directly contain exactly these keys:
   - executiveSummary (string, 3-4 paragraphs)
   - topPriorities (array of {priority, action, impact, timeframe})
   - quickWins (array of strings)
   - strategicThemes (array of strings)
   - overallInsight (one powerful sentence)`;

  const userPrompt = `Website: ${crawledData.url}
Industry: ${crawledData.industry || 'General'}
Overall Audit Score: ${overallScore}/100
Pages Analysed: ${crawledData.pages?.length || 0}

Plugin Results:
${pluginSummaries}

Return a synthesis in this exact JSON shape:
{
  "executiveSummary": "3-4 paragraph narrative...",
  "topPriorities": [{"priority": 1, "action": "...", "impact": "High/Medium/Low", "timeframe": "..."}],
  "quickWins": ["string"],
  "strategicThemes": ["string"],
  "overallInsight": "one powerful sentence"
}`;

  try {
    const anthropic = getSynthesisClient();

    // ── Prompt inspection log ─────────────────────────────────
    console.log(`[Claude:synthesis] ── Sending synthesis prompt to ${SYNTHESIS_MODEL} ──`);
    console.log(`[Claude:synthesis]   system prompt : ${systemPrompt.length} chars`);
    console.log(`[Claude:synthesis]   user prompt   : ${userPrompt.length} chars`);
    console.log(`[Claude:synthesis]   max_tokens    : 3000`);
    // ─────────────────────────────────────────────────────────

    const message = await anthropic.messages.create({
      model: SYNTHESIS_MODEL,
      max_tokens: 3000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const raw = message.content[0]?.text || '{}';
    const parsed = parseJSON(raw, 'synthesis');
    console.log(`[Claude] ✓ Synthesis complete`);
    return parsed;

  } catch (err) {
    console.error(`[Claude] Synthesis failed: ${err.message}`);
    // Graceful fallback — build a minimal synthesis from plugin summaries
    const topRecs = pluginResults
      .flatMap(r => r.recommendations || [])
      .slice(0, 5)
      .map(r => (typeof r === 'string' ? r : r.action || ''))
      .filter(Boolean);

    return {
      executiveSummary: `This audit analysed ${crawledData.url} across ${pluginResults.length} dimensions, achieving an overall score of ${overallScore}/100.\n\n${pluginSummaries.slice(0, 800)}`,
      topPriorities: topRecs.slice(0, 3).map((a, i) => ({ priority: i + 1, action: a, impact: 'High', timeframe: 'This month' })),
      quickWins: topRecs.slice(0, 5),
      strategicThemes: ['SEO & Content', 'Brand Consistency', 'Conversion Optimisation'],
      overallInsight: `Overall audit score: ${overallScore}/100 — targeted improvements will significantly lift digital performance.`,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// calculateOverallScore — Weighted average across plugin results
// ─────────────────────────────────────────────────────────────
export function calculateOverallScore(pluginResults) {
  const valid = pluginResults.filter(r => r.score > 0);
  if (valid.length === 0) return 0;

  const totalWeight = valid.reduce((s, r) => s + (r.weight || 1), 0);
  const weightedSum = valid.reduce((s, r) => s + r.score * (r.weight || 1), 0);

  return Math.round(weightedSum / totalWeight);
}

// ─────────────────────────────────────────────────────────────
// parseJSON — Robust JSON extractor for Claude responses
// ─────────────────────────────────────────────────────────────
function parseJSON(text, context = 'plugin') {
  // 1. Direct parse (fastest — works when model obeys rules)
  try { return JSON.parse(text.trim()); } catch (_) {}

  // 2. Strip markdown fences — handles complete ``` ... ``` blocks
  const fenceMatch = text.match(/```(?:json|JSON)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch (_) {}
  }

  // 3. Opening fence only (truncated response) — extract everything after the fence
  const openFence = text.match(/```(?:json|JSON)?\s*([\s\S]*)/);
  if (openFence) {
    // Try to parse as-is (might be valid JSON even without closing fence)
    try { return JSON.parse(openFence[1].trim()); } catch (_) {}
  }

  // 4. Bracket-depth scan — finds the outermost valid JSON object
  //    Catches partial fences, leading prose, trailing commentary
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch (_) {}
        start = -1;
      }
    }
  }

  // 5. Truncation recovery — response was cut off mid-JSON; try to close it
  //    Find the last complete top-level key-value pair and close the object
  const lastBrace = text.lastIndexOf(',');
  if (lastBrace > 0) {
    const candidate = text.slice(0, lastBrace) + '}';
    try { return JSON.parse(candidate.includes('{') ? candidate.slice(candidate.indexOf('{')) : candidate); } catch (_) {}
  }

  console.warn(`[Claude] Could not parse JSON for "${context}". Raw preview:`, text.slice(0, 200));
  return { score: 0, summary: text.slice(0, 500), parseError: true };
}
