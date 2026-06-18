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
- ALL quotes inside string values must be escaped as \\" — NEVER use unescaped double quotes inside a string.

════════════════════════════════════════════════════════
IMPLEMENTATION CHANGES — CRITICAL REQUIREMENT
════════════════════════════════════════════════════════
You MUST include "implementationChanges" with 8–15 copy-and-paste-ready content pieces.
- The "implementationChanges" MUST directly implement the specific "recommendations" you provide in your analysis. Each change should be the actual execution of a corresponding recommendation.
- For Content & Copy, all changes MUST ONLY consist of content rewrites, landing page copy, or blog outlines that can be directly modified on the user's website. Do NOT propose off-site changes (such as off-site social posts or email copy).
- "title" must be the name of the page in the URL where the change will be made (e.g., "home page", "contact page", "about us page").
- "location": name of the page in the URL where the change is located (e.g., "home page", "contact page", "about us page").
- "sourceUrl": exact source URL of the page where the change is located (taken from the crawl data).
- "actionType" must be one of: replace, insert_after, insert_before, create_page. Use create_page for entirely new sub-services or pages.
- "targetSelector" is an optional CSS selector or logical name of the section where the change applies.
- "currentState" must quote the EXACT existing copy from the website. If you are adding entirely new content, set this to the nearest existing text to act as an anchor point.
- "proposedChange" must be the COMPLETE finished piece of content. If you used an anchor in currentState to add new content, you MUST include the anchor text in proposedChange alongside the new content.
- No ellipsis, no [brackets], no "to be written later" — write the entire content piece.`,

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
    ],
    implementationChanges: [
      {
        title: 'string — name of the page in the URL, e.g. "home page" or "contact page"',
        priority: 'string — High / Medium / Low',
        impactScore: 'number 1-100',
        description: 'string — why this copy change is needed',
        currentState: 'string — EXACT current copy from the website',
        proposedChange: 'string — COMPLETE replacement copy, ready to publish as-is',
        actionType: 'string -- one of: replace, insert_after, insert_before, create_page',
        targetSelector: 'string -- optional CSS selector or widget name to target',
        changeType: 'string — one of: headline / cta / body / social / email / meta',
        location: 'string — name of the page in the URL, e.g. "home page" or "contact page"',
        sourceUrl: 'string — the exact URL of the page where the change is located (from the crawl data)'
      }
    ]
  },

  buildUserPrompt(crawledData) {
    const pages = crawledData.pages || [];
    const urlMap = pages.length > 0
      ? pages.map(p => `  - ${p.url}  ->  "${p.title || 'Untitled'}"`).join('\n')
      : `  - ${crawledData.url}  ->  "Home page"`;

    return `Audit and create a content strategy for this business:

WEBSITE URL: ${crawledData.url}
INDUSTRY: ${crawledData.industry}

================================================================
CRAWLED PAGE URL MAP -- CRITICAL
You MUST use ONLY these exact URLs for "sourceUrl" in every implementationChange.
Copy the URL character-for-character. Do NOT invent or modify these URLs.
================================================================
${urlMap}
================================================================

HOMEPAGE COPY:
${JSON.stringify(crawledData.homepage?.copy || {}, null, 2)}

ALL PAGE CONTENT (titles, descriptions, body):
${JSON.stringify(pages.slice(0, 15), null, 2)}

EXISTING CTAs FOUND:
${JSON.stringify(crawledData.ctaText || [], null, 2)}

BRAND SIGNALS (fonts, colours, imagery descriptions):
${JSON.stringify(crawledData.brandSignals || {}, null, 2)}

Return your content audit and strategy as valid JSON matching the outputFormat exactly.`;
  },
};



