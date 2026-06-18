// ============================================================
// backend/plugins/brand-review.js
// Brand Review Plugin — Full /brand-review protocol.
// Voice, style, claims, legal safety, before/after fixes.
// ============================================================

export default {
  id:                 'brand-review',
  name:               'Brand Review',
  description:        'Reviews content against brand voice, style guide, and messaging pillars. Flags deviations by severity with specific before/after fixes and legal compliance checks (ACL/ACCC).',
  estimatedRuntime:   35,
  weight:             0.13,
  maxTokens: 16384,

  systemPrompt: `You are a senior brand editor and legal compliance reviewer executing the full /brand-review audit protocol.

════════════════════════════════════════════════════════
REVIEW DIMENSIONS
════════════════════════════════════════════════════════

1. VOICE AND TONE
   Evaluate the brand as if it were a person. Position its attributes on these spectrums:
   - Formality:   Formal / Casual
   - Authority:   Expert / Peer-level
   - Emotion:     Warm / Matter-of-fact
   - Complexity:  Technical / Accessible
   - Energy:      Bold / Calm
   - Humor:       Playful / Serious
   - Innovation:  Cutting-edge / Established
   Flag any sentences or phrases that deviate from the dominant voice with exact quotes.
   Flag tone shifts between pages (e.g., one page is casual, another is stiff and formal).

2. TERMINOLOGY AND LANGUAGE
   - Are preferred brand terms used correctly?
   - Is jargon appropriate for the audience?
   - Are product or company names formatted correctly?
   - Flag any ableist language ("crazy", "blind spot", "lame"), gendered assumptions, or culturally exclusive idioms.
   - Check for sign up vs. signup, log in vs. login, set up vs. setup, email vs. e-mail.
   - Flag ALL CAPS usage (use bold for emphasis instead).
   - Flag excessive exclamation marks.

3. MESSAGING PILLARS
   - Does the copy align with clear value propositions?
   - Are claims consistent across pages (no contradictions)?
   - Is the content reinforcing or undermining brand positioning?

4. STYLE GUIDE COMPLIANCE
   - Oxford comma consistency
   - Heading case (sentence case vs. title case — flag inconsistencies)
   - Contractions policy
   - Em dash spacing
   - Number formatting (spell out 1–9, numerals 10+)
   - Link text quality (flag "click here", "read more" without context)
   - Ellipsis and emoji usage in professional contexts
   - Percentage formatting (% vs. percent)

5. LEGAL AND COMPLIANCE FLAGS — HIGHEST PRIORITY (Always Check)
   Flag EVERY instance of:
   - Unsubstantiated superlatives: "best", "fastest", "only", "world-class", "leading", "#1" without evidence
   - Missing disclaimers: financial claims, guarantees, health claims
   - Comparative claims: any comparison to competitors without cited data
   - Testimonial issues: quotes or endorsements without attribution or disclosure
   - Regulatory language: content that may need compliance review (financial services, healthcare)
   - Copyright concerns: content closely paraphrased from other sources
   - ACL/ACCC risk: any claim that could breach Australian Consumer Law Sections 18, 29, 33, or 34

════════════════════════════════════════════════════════
SCORING RUBRIC
════════════════════════════════════════════════════════
Score the business's brand safety and consistency from 0–100:

90–100: Brand-safe — Consistent voice, fully compliant claims, no legal risk, strong style adherence
75–89:  Mostly safe — Minor inconsistencies, 1–2 low-risk style issues, no legal red flags
60–74:  Some risk — Inconsistent tone OR several unsubstantiated claims OR repeated style violations
45–59:  At risk — Multiple HIGH-severity findings OR legal compliance gaps
0–44:   High risk — CRITICAL legal compliance issues, severe brand incoherence, or misleading claims

Category weights (each scored 0–100):
- Legal Compliance:      35%
- Voice Consistency:     25%
- Claim Substantiation:  25%
- Style Adherence:       15%

The overall score = (legalCompliance × 0.35) + (voiceConsistency × 0.25) + (claimSubstantiation × 0.25) + (styleAdherence × 0.15)

════════════════════════════════════════════════════════
OUTPUT RULES — READ CAREFULLY
════════════════════════════════════════════════════════
1. YOUR RESPONSE MUST START WITH { AND END WITH }
2. DO NOT use markdown code fences (no \`\`\`json or \`\`\`).
3. DO NOT add any text before the opening { or after the closing }.
4. Respond ONLY with raw, valid JSON matching the outputFormat exactly.
5. Quote EXACT text from the website for every finding.
6. Include the page URL for every finding.
7. Use Australian English throughout.
8. Do NOT invent data — only reference what is in the crawl provided.

════════════════════════════════════════════════════════
IMPLEMENTATION CHANGES — CRITICAL REQUIREMENT
════════════════════════════════════════════════════════
You MUST include an "implementationChanges" array with 6–12 copy-paste-ready fixes.
- The "implementationChanges" MUST directly implement the specific "recommendations" you provide in your analysis. Each change should be the actual execution of a corresponding recommendation.
- For Brand Review, all changes MUST ONLY consist of content rewrites, voice adjustments, or legal/compliance fixes that can be directly modified on the user's website. Do NOT propose off-site changes.
- "title" must be the name of the page in the URL where the change will be made (e.g., "home page", "contact page", "about us page").
- "location": name of the page in the URL where the change is located (e.g., "home page", "contact page", "about us page").
- "sourceUrl": exact source URL of the page where the change is located (taken from the crawl data).
- "currentState": EXACT quote of the problematic text as it appears on the site. If you are adding entirely new content, set this to the nearest existing text to act as an anchor point.
- "proposedChange": COMPLETE rewritten version — no placeholders, no "...", fully finished. If you used an anchor in currentState to add new content, you MUST include the anchor text in proposedChange alongside the new content.
- Bad: "Rewrite the hero headline to be clearer"
- Good: currentState="We help businesses grow" proposedChange="Data-driven digital marketing that generates measurable ROI — for Australian businesses ready to scale"`,

  scoringPrompt: `Score this business's brand safety and consistency from 0–100 using these weighted categories:
- Legal Compliance (35%): Are claims substantiated? Any ACL/ACCC risks?
- Voice Consistency (25%): Is tone consistent across pages?
- Claim Substantiation (25%): Are superlatives backed by evidence?
- Style Adherence (15%): Is formatting and style consistent?`,

  outputFormat: {
    score: 'number (0–100, calculated as weighted average of categoryScores)',
    categoryScores: {
      legalCompliance:     'number (0–100)',
      voiceConsistency:    'number (0–100)',
      claimSubstantiation: 'number (0–100)',
      styleAdherence:      'number (0–100)',
    },
    summary: 'string — 2 sentences on biggest strengths, 2 sentences on most important improvements',
    detailedFindings: [
      {
        issue:    'string — concise description of the issue',
        location: 'string — page URL and HTML element (e.g. homepage H1, /services page hero)',
        severity: 'string — High / Medium / Low',
        quote:    'string — exact text from the website (verbatim)',
        suggestion: 'string — specific improvement recommendation',
      }
    ],
    revisedSections: [
      {
        originalText:      'string — exact text currently on the website',
        suggestedRevision: 'string — improved rewrite',
        reason:            'string — why this change improves brand safety or voice',
        severity:          'string — High / Medium',
      }
    ],
    legalAndComplianceFlags: [
      {
        issue:             'string — description of the legal/compliance concern',
        quote:             'string — exact text triggering the flag',
        location:          'string — page URL',
        riskLevel:         'string — Critical / High / Medium',
        recommendedAction: 'string — specific action to remediate',
      }
    ],
    voiceAndToneProfile: {
      personality:       'string — one sentence describing the brand voice as a person',
      dominantTone:      'string — e.g. "professional and direct with occasional warmth"',
      attributes:        ['string — e.g. "Authoritative", "Approachable", "Technical"'],
      spectrumPositions: {
        formality:   'string — e.g. "Mid-formal (leans institutional)"',
        authority:   'string — e.g. "Expert-level"',
        emotion:     'string — e.g. "Matter-of-fact"',
        complexity:  'string — e.g. "Technical with accessible explanations"',
        energy:      'string — e.g. "Calm and measured"',
        humor:       'string — e.g. "Serious, no humor detected"',
        innovation:  'string — e.g. "Established, proven approach"',
      },
      toneAdaptations: ['string — e.g. "More formal in legal/compliance pages"'],
      styleGuideSuggestions: ['string — e.g. "Standardise heading case to sentence case"'],
    },
    recommendations: [
      {
        priority:       'number (1 = highest)',
        action:         'string — specific, actionable recommendation',
        expectedImpact: 'string — High / Medium / Low',
        effort:         'string — Quick Win (< 2 hours) / Strategic Investment',
        rationale:      'string — why this matters for brand safety or voice',
      }
    ],
    implementationChanges: [
      {
        title: 'string — name of the page in the URL, e.g. "home page" or "contact page"',
        priority: 'string — High / Medium / Low',
        impactScore: 'number 1-100',
        description: 'string — why this change is needed',
        currentState: 'string — EXACT current text from the website',
        proposedChange: 'string — EXACT rewritten replacement text, ready to publish',
        changeType: 'string — one of: content / legal / voice / metadata',
        location: 'string — name of the page in the URL, e.g. "home page" or "contact page"',
        sourceUrl: 'string — the exact URL of the page where the change is located (from the crawl data)'
      }
    ],
  },

  // ── Prompt Builder ─────────────────────────────────────────
  buildUserPrompt(crawledData) {
    const pagesCopy = (crawledData.pages || []).map(p => ({
      url:      p.url,
      title:    p.title,
      metaDesc: p.metaDescription,
      h1:       p.h1,
      h2s:      (p.h2s || []).slice(0, 6),
      bodyText: (p.bodyText || p.bodyExcerpt || '').slice(0, 2500),
    }));

    const allCopyFlat = pagesCopy
      .map(p =>
        `--- PAGE: ${p.url} ---\n` +
        `Title: ${p.title || '(none)'}\n` +
        `Meta: ${p.metaDesc || '(none)'}\n` +
        `H1: ${p.h1 || '(none)'}\n` +
        `H2s: ${(p.h2s || []).join(' | ') || '(none)'}\n` +
        `Body excerpt: ${p.bodyText || '(none)'}`
      )
      .join('\n\n');

    return `Conduct a full /brand-review audit for this business website.

================================================================
WEBSITE INFORMATION
================================================================
URL:           ${crawledData.url}
Industry:      ${crawledData.industry || 'Not specified'}
Pages crawled: ${pagesCopy.length}

================================================================
CRAWLED PAGE URL MAP -- CRITICAL
You MUST use ONLY these exact URLs for "sourceUrl" in every implementationChange.
Copy the URL character-for-character. Do NOT invent or modify these URLs.
================================================================
${pagesCopy.map(p => `  - ${p.url}  ->  "${p.title || 'Untitled'}"`).join('\n')}
================================================================

================================================================
ALL PAGE COPY
================================================================
${allCopyFlat}

════════════════════════════════════════════════════════
TESTIMONIALS & SOCIAL PROOF
════════════════════════════════════════════════════════
${JSON.stringify(crawledData.testimonials || [], null, 2)}

════════════════════════════════════════════════════════
PRICING COPY
════════════════════════════════════════════════════════
${JSON.stringify(crawledData.pricingCopy || [], null, 2)}

════════════════════════════════════════════════════════
DETECTED CLAIMS & SUPERLATIVES
════════════════════════════════════════════════════════
${JSON.stringify(crawledData.claims || [], null, 2)}

════════════════════════════════════════════════════════
SCHEMA / STRUCTURED DATA
════════════════════════════════════════════════════════
${JSON.stringify(crawledData.schema || [], null, 2)}

════════════════════════════════════════════════════════
REVIEW INSTRUCTIONS
════════════════════════════════════════════════════════
Apply the full /brand-review protocol:

1. VOICE & TONE — Position the brand on each spectrum. Flag any voice shifts between pages with exact quotes and page URLs.

2. TERMINOLOGY — Check for preferred/avoided terms. Flag ableist, exclusive, or inconsistent language. Flag ALL CAPS, excessive exclamation marks, and vague link text ("click here").

3. MESSAGING PILLARS — Identify what the brand is saying vs. what it should say. Note contradictions.

4. STYLE GUIDE COMPLIANCE — Check Oxford comma, heading case, contractions, em dash, number formatting, exclamation marks, emoji, ellipsis.

5. LEGAL / COMPLIANCE FLAGS — Flag EVERY unsubstantiated superlative, missing disclaimer, comparative claim, testimonial compliance issue, or ACL/ACCC risk. Flag as CRITICAL if it could breach Sections 18, 29, 33, or 34 of the Australian Consumer Law.

6. BEFORE/AFTER REWRITES — Provide a specific rewrite for every HIGH and MEDIUM severity finding.

7. VOICE PROFILE — Based on detected patterns, summarise the brand voice using the spectrum framework.

REMEMBER:
- Start your response with { — NO markdown fences, NO preamble text
- Quote EXACT text from the website for every finding
- Include page URL for every finding
- Use Australian English
- Do NOT invent data — only reference what is in the crawl above

CALCULATE THE SCORE:
score = round((legalCompliance × 0.35) + (voiceConsistency × 0.25) + (claimSubstantiation × 0.25) + (styleAdherence × 0.15))

Return your complete brand review as raw JSON matching the outputFormat exactly.`;
  },
};


