// ============================================================
// backend/plugins/seo-audit.js
// SEO Audit Plugin — keyword, on-page, technical & gap analysis
// ============================================================

export default {
  id: 'seo-audit',
  name: 'SEO Audit',
  description: 'Keyword, on-page, technical, gap and competitor analysis — prioritised action plan.',
  estimatedRuntime: 45,
  weight: 0.25,
  maxTokens: 16384, // contribution to overall audit score

  // ── System Prompt ────────────────────────────────────────────
  systemPrompt: `You are an expert SEO strategist and technical SEO specialist with 15+ years of experience.
You are conducting a comprehensive SEO audit for a business website. Write in Australian English throughout.

Your task is to analyse the provided website data across FIVE areas and produce a detailed, commercially actionable SEO audit.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. KEYWORD RESEARCH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
For each keyword opportunity assess:
- Primary keywords — high-intent terms directly tied to the business's product or service
- Secondary keywords — supporting terms and variations
- Search volume signals — relative demand (high, medium, low)
- Keyword difficulty — how competitive the term is (easy, moderate, hard)
- Long-tail opportunities — specific, lower-competition phrases with clear intent
- Question-based keywords — "how to", "what is", "why does" queries mirroring People Also Ask
- Intent classification — informational, navigational, commercial, or transactional
Include 15–25 keyword opportunities sorted by opportunity score (high first).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2. ON-PAGE SEO AUDIT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
For each key page (homepage, top landing pages, recent blog posts) evaluate:
- Title tags — present, unique, within 50–60 characters, includes target keyword
- Meta descriptions — present, compelling, within 150–160 characters, includes a CTA
- H1 tags — exactly one per page, includes primary keyword
- H2/H3 structure — logical hierarchy, uses secondary keywords where natural
- Keyword usage — primary keyword appears in the first 100 words, used naturally
- Internal linking — pages link to related content, orphan pages identified, anchor text is descriptive
- Image alt text — all images have descriptive alt attributes, keywords included where relevant
- URL structure — clean, readable, includes keywords, no excessive parameters or depth
Cite the ACTUAL page URL and issue for each finding.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
3. CONTENT GAP ANALYSIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Identify what is missing from the content strategy:
- Competitor topic coverage — topics/keywords competitors rank for that the site does not cover
- Content freshness — pages not updated in 12+ months and may be losing rankings
- Thin content — pages with insufficient depth to rank (under 300 words for informational queries)
- Missing content types — formats competitors use that the site doesn't (guides, comparison pages, glossaries, tools, templates)
- Funnel gaps — missing content at specific buyer journey stages (awareness, consideration, decision)
- Topic clusters — opportunities to build pillar pages with supporting content
For each gap provide: topic, why it matters, recommended format, priority (high/medium/low), estimated effort.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
4. TECHNICAL SEO CHECKLIST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Evaluate technical foundations — status MUST be Pass, Fail, or Warning:
- Page speed — slow-loading pages and likely causes (large images, render-blocking scripts)
- Mobile-friendliness — responsive design, tap targets, font sizes, viewport
- Structured data — opportunities for schema markup (FAQ, HowTo, Product, Article, LocalBusiness)
- Crawlability — robots.txt, XML sitemap presence, canonical tags, noindex/nofollow usage
- Broken links — internal and external 404s, redirect chains
- HTTPS — secure connection, mixed content issues
- Core Web Vitals — LCP, FID/INP, CLS indicators based on observable page behaviour
- Indexation — pages that should be indexed but may not be, duplicate content risks

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
5. COMPETITOR SEO COMPARISON
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
For TWO specific named competitors (use Perplexity research data if available, otherwise infer from industry), compare:
- Keyword count and overlap
- Content depth (avg word count, topic breadth, publishing frequency)
- Backlink signals (types of sites linking, link-worthy content produced)
- SERP feature ownership (featured snippets, People Also Ask, image packs, knowledge panels)
- Technical score advantages (speed, mobile, structured data)
- Domain authority signals (relative strength based on content and backlink profile)
Name the winner for each dimension. Include 6–8 comparison rows.

FOLLOW-UP OFFER:
After your analysis, mentally note that the user may want: content briefs for top keyword opportunities, optimised title tags and meta descriptions, a content calendar based on the gap analysis, deeper analysis of any section, or the same analysis for a different competitor or domain.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT RULES — READ CAREFULLY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. YOUR RESPONSE MUST START WITH { AND END WITH }
2. DO NOT use markdown code fences (no \`\`\`json or \`\`\`).
3. DO NOT add any text before the opening { or after the closing }.
4. Respond ONLY with raw, valid JSON matching the outputFormat exactly.

CRITICAL JSON RULES — failure to follow these causes a parse error:
- ALL string values must be on a single line. Use \\n (backslash-n) for line breaks within strings — NEVER use actual newlines inside a JSON string value.
- ALL quotes inside string values must be escaped as \\" — NEVER use unescaped double quotes inside a string.`,

  // ── Scoring Prompt ───────────────────────────────────────────
  scoringPrompt: `Based on your SEO analysis, assign a score from 0–100 using this rubric:

90–100: Excellent — Strong fundamentals, minimal issues, competitive keyword presence, rich content
75–89:  Good — Solid foundation with clear improvement opportunities across 1–2 areas
60–74:  Fair — Notable issues impacting rankings and visibility that need addressing
45–59:  Poor — Significant SEO problems across multiple areas requiring immediate attention
0–44:   Critical — Fundamental SEO failures, site likely invisible in search results

Score EACH category independently (0–100), then calculate weighted overall:
- Technical SEO: 30% weight — crawlability, speed, structured data, HTTPS, indexation
- On-Page SEO: 30% weight — title tags, meta descriptions, H1/H2 structure, keyword usage
- Content Quality & Gaps: 20% weight — content depth, freshness, funnel coverage, topic clusters
- Keyword Coverage & Competitor Comparison: 20% weight — keyword breadth, SERP visibility, competitive positioning

Quick Wins are actions taking under 2 hours with immediate impact (fix title tags, add meta descriptions, fix broken links, add alt text).
Strategic Investments are longer-term actions (build topic clusters, create pillar pages, launch link-building campaigns, overhaul site structure).

Return all scores as integers.`,


  // ── Output Format ────────────────────────────────────────────
  outputFormat: {
    score: 'number (0-100)',
    categoryScores: {
      technical: 'number',
      onPage: 'number',
      content: 'number',
      keywords: 'number',
    },
    summary: 'string (3-5 sentence executive summary outlining top strength, top 3 priorities, and overall assessment)',
    keywordOpportunities: [
      {
        keyword: 'string',
        estimatedDifficulty: 'string (easy/moderate/hard)',
        opportunityScore: 'string (high/medium/low)',
        currentRanking: 'string (or N/A)',
        intent: 'string (informational/navigational/commercial/transactional)',
        recommendedContentType: 'string'
      }
    ],
    onPageIssues: [
      {
        pageUrl: 'string',
        issue: 'string',
        severity: 'string (Critical/High/Medium/Low)',
        recommendedFix: 'string'
      }
    ],
    contentGaps: [
      {
        topic: 'string',
        whyItMatters: 'string',
        recommendedFormat: 'string',
        priority: 'string (High/Medium/Low)',
        estimatedEffort: 'string (Quick win/Moderate/Substantial)'
      }
    ],
    technicalChecklist: [
      {
        check: 'string',
        status: 'string (Pass/Fail/Warning)',
        details: 'string'
      }
    ],
    competitorComparison: [
      {
        dimension: 'string (Keyword count, content depth, etc.)',
        yourSite: 'string',
        competitorA: 'string',
        competitorB: 'string',
        winner: 'string'
      }
    ],
    recommendations: [
      {
        priority: 'number (1-based)',
        action: 'string (Concrete action to take)',
        expectedImpact: 'string (High/Medium/Low)',
        effort: 'string (Quick Win / Strategic Investment)',
        timeframe: 'string',
        dependencies: 'string (or None)'
      }
    ],
  },

  // ── Prompt Builder ───────────────────────────────────────────
  buildUserPrompt(crawledData) {
    const kwStats  = crawledData.keywordStats  ?? {};
    const kwIdeas  = crawledData.keywordIdeas  ?? [];
    const onPage   = crawledData.onPageAudit   ?? null;
    const rankings = crawledData.serpRankings  ?? [];

    return `Please conduct a full SEO audit on the following website data:

WEBSITE URL: ${crawledData.url}
INDUSTRY: ${crawledData.industry}

PAGE DATA:
${JSON.stringify(crawledData.pages?.slice(0, 20) || [], null, 2)}

CORE WEB VITALS (via Perplexity):
${JSON.stringify(crawledData.coreWebVitals || {}, null, 2)}

META SIGNALS:
${JSON.stringify(crawledData.metaSignals || {}, null, 2)}

SCHEMA MARKUP FOUND:
${JSON.stringify(crawledData.schema || [], null, 2)}

──────────────────────────────────────────
PERPLEXITY — KEYWORD RESEARCH (top ${kwIdeas.slice(0, 30).length} of ${kwStats.total ?? 0} keywords found)
──────────────────────────────────────────
Total keywords found: ${kwStats.total ?? 0}
High-volume keywords (1000+ searches/mo): ${kwStats.highVolume ?? 0}
Low-difficulty opportunities (<30 KD): ${kwStats.lowDifficulty ?? 0}

Top keyword ideas (by search volume):
${JSON.stringify(kwIdeas.slice(0, 30), null, 2)}

──────────────────────────────────────────
PERPLEXITY — ON-PAGE AUDIT
──────────────────────────────────────────
${onPage ? JSON.stringify(onPage, null, 2) : 'On-page audit data unavailable.'}

──────────────────────────────────────────
PERPLEXITY — SERP RANKINGS (top 10 keywords)
──────────────────────────────────────────
Keywords ranked in top 10: ${rankings.filter(r => r.position !== null && r.position <= 10).length} / ${rankings.length}
Average position: ${kwStats.avgPosition ?? 'N/A'}

${JSON.stringify(rankings, null, 2)}

Provide your full SEO audit as valid JSON matching the outputFormat exactly.`;
  },
};


