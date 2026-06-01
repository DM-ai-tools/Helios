// ============================================================
// backend/plugins/content-copy.js
// Content & Copy Plugin — blog, social, ads, landing pages
// ============================================================

export default {
  id: 'content-copy',
  name: 'Content & Copy',
  description: 'Blog, social, ads, landing pages, case studies — channel-specific, on-brand.',
  estimatedRuntime: 50,
  weight: 0.17,
  maxTokens: 16384,

  systemPrompt: `You are a world-class content strategist and copywriter specialising in digital marketing.
You create channel-specific, on-brand content across all major formats.

Your task is to audit existing website copy AND produce a content strategy with actual drafted copy examples.

CONTENT GUIDELINES & BEST PRACTICES:
1. Blog Posts: Clear benefit-driven headline (<60 chars, with keyword). Intro (100-150 words) hooks reader. 3-5 Body sections with H2/H3 subheadings. Conclusion with CTA. Write at an 8th-grade level, short paragraphs, bullet points.
2. Social Media: Hook first line, 2-4 points/narrative, clear CTA, 3-5 hashtags. Platform specifics: LinkedIn (professional/human, stories), X (punchy, threads), Instagram (visual-first, line breaks), Facebook (conversational, questions).
3. Email Newsletters: Subject line (<50 chars, curiosity/value). Preview text (complements subject). Header/hero value statement. 2-3 scannable blocks. One primary visually distinct CTA.
4. Landing Pages: Headline (primary benefit, <10 words). Subheadline. Hero section. 3-4 Value propositions. Social proof. Objection handling. Final CTA. Lead with benefits, use "you" language.
5. Press Releases: Factual newsworthy headline (<80 chars). Dateline. Lead paragraph (who/what/when/where/why). Body paragraphs. Boilerplate. Media contact.
6. Case Studies: Title ("[Customer] achieves [result] with [product]"). Snapshot (stats/callout). Challenge. Solution. Results (quantified). Quote. CTA.

SEO FUNDAMENTALS:
- Primary keyword in: headline, first paragraph, one subheading, meta description, URL slug. Use secondary keywords naturally. Do not keyword-stuff.

HEADLINES & HOOKS:
- Use formulas like: "How to [result] without [obstacle]", "[Number] ways to [result]", "The complete guide to [topic]".
- Hooks: Surprising statistic, contrarian statement, question, bold claim.

CTA PRINCIPLES:
- Action verbs (Get, Start, Try). Be specific. Create urgency. One primary CTA per piece.

IMPORTANT RULES:
- Write ACTUAL drafted copy examples following the exact structures above — not just descriptions of what to write.
- Match the brand voice detected from the website.
- Split your Prioritized Action Plan (Recommendations) into Quick Wins (do this week, < 2 hours) and Strategic Investments.

════════════════════════════════════════════════════════
OUTPUT RULES — READ CAREFULLY
════════════════════════════════════════════════════════
1. YOUR RESPONSE MUST START WITH { AND END WITH }
2. DO NOT use markdown code fences (no \`\`\`json or \`\`\`).
3. DO NOT add any text before the opening { or after the closing }.
4. Respond ONLY with raw, valid JSON matching the outputFormat exactly.

CRITICAL JSON RULES — failure to follow these causes a parse error:
- ALL string values must be on a single line. Use \\n (backslash-n) for line breaks within strings — NEVER use actual newlines inside a JSON string value.
- ALL quotes inside string values must be escaped as \\" — NEVER use unescaped double quotes inside a string.`,

  scoringPrompt: `Score this business's content and copy quality (0–100):

90–100: Exceptional — Compelling, differentiated, conversion-focused copy throughout
75–89:  Strong — Good copy with clear voice, minor improvements needed
60–74:  Average — Copy communicates but doesn't compel
45–59:  Weak — Generic, unclear, or misaligned copy
0–44:   Poor — Copy actively deters conversion

Categories (each 0–100):
- Homepage & Landing Page Copy: 30% weight
- Blog & SEO Content Structure: 25% weight
- Content Volume & Variety: 25% weight
- CTA & Hook Effectiveness: 20% weight`,

  outputFormat: {
    score: 'number (0-100)',
    categoryScores: {
      homepageCopy: 'number',
      seoContent: 'number',
      contentVolume: 'number',
      ctaEffectiveness: 'number',
    },
    summary: 'string (Executive summary)',
    voiceAndTone: {
      current: 'string',
      recommended: 'string',
      adjectives: ['string']
    },
    contentDrafts: {
      blogPost: {
        headline: 'string',
        metaDescription: 'string',
        primaryKeyword: 'string',
        fullDraft: 'string (Markdown formatted with H2/H3, Intro, Body, Conclusion, CTA)'
      },
      socialMediaPosts: [
        {
          platform: 'string (LinkedIn/X/Instagram/Facebook)',
          hook: 'string',
          body: 'string',
          cta: 'string',
          hashtags: ['string']
        }
      ],
      emailNewsletter: {
        subjectLine: 'string',
        previewText: 'string',
        heroStatement: 'string',
        bodyBlocks: ['string'],
        primaryCTA: 'string'
      },
      landingPage: {
        headline: 'string',
        subheadline: 'string',
        valuePropositions: ['string'],
        socialProofRecommendation: 'string',
        primaryCTA: 'string'
      },
      pressRelease: {
        headline: 'string',
        dateline: 'string',
        leadParagraph: 'string',
        body: 'string'
      },
      caseStudy: {
        title: 'string',
        snapshot: 'string',
        challenge: 'string',
        solution: 'string',
        results: 'string',
        quoteIdea: 'string',
        cta: 'string'
      }
    },
    recommendations: [
      {
        priority: 'number',
        action: 'string',
        expectedImpact: 'string (High/Medium/Low)',
        effort: 'string (Quick Win / Strategic Investment)'
      }
    ]
  },

  buildUserPrompt(crawledData) {
    return `Audit and create a content strategy for this business:

WEBSITE URL: ${crawledData.url}
INDUSTRY: ${crawledData.industry}

HOMEPAGE COPY:
${JSON.stringify(crawledData.homepage?.copy || {}, null, 2)}

ALL PAGE CONTENT (titles, descriptions, body):
${JSON.stringify(crawledData.pages?.slice(0, 15) || [], null, 2)}

EXISTING CTAs FOUND:
${JSON.stringify(crawledData.ctaText || [], null, 2)}

BRAND SIGNALS (fonts, colours, imagery descriptions):
${JSON.stringify(crawledData.brandSignals || {}, null, 2)}

Return your content audit and strategy as valid JSON matching the outputFormat exactly.`;
  },
};


