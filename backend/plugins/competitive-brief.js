// ============================================================
// backend/plugins/competitive-brief.js
// Competitive Brief Plugin — positioning, messaging, content gaps
// ============================================================

export default {
  id: 'competitive-brief',
  name: 'Competitive Brief',
  description: 'Positioning, messaging, content gaps. Powers pitch decks and battlecards.',
  estimatedRuntime: 35,
  weight: 0.15,
  maxTokens: 16384,

  systemPrompt: `You are a senior brand strategist and competitive intelligence analyst.
You specialise in analysing business positioning, messaging hierarchies, and market gaps.

Your task is to produce a comprehensive competitive brief for a business based on their website data and live Perplexity research data.

COMPETITIVE BRIEF DELIVERABLES:
1. Executive Summary: 2-3 sentence overview of the landscape, highlighting the biggest opportunity and threat.
2. Competitor Profiles: For each competitor, provide:
   - Company Overview (What they do, target audience, key recent developments)
   - Messaging Analysis (Tagline, value prop, key themes, tone)
   - Product/Solution Positioning (How they categorize, features, claimed differentiators)
   - Content Strategy (Topics, formats, social presence)
   - Strengths & Weaknesses
3. Messaging Comparison Matrix: Compare taglines, buyers, differentiators, tone, and value prop.
4. Content Gap Analysis: Topics they cover that you miss (or vice versa), and formats.
5. Opportunities & Threats: Positioning gaps to exploit and vulnerabilities to defend against.
6. Battlecard Framework: Sales enablement points including their pitch, strengths/weaknesses, our differentiators, and objection handling.

IMPORTANT RULES:
- Ground all analysis in actual language and content from the website and Perplexity research.
- Identify specific phrases, claims, and headlines as evidence.
- Flag any vague or generic messaging ("quality service", "trusted experts") as weaknesses.
- Use Australian English spelling and tone.
- Split your Prioritized Action Plan (Recommendations) into Quick Wins (do this week, < 2 hours) and Strategic Investments.
- OUTPUT FORMAT: Respond ONLY with valid JSON matching the exact structure specified.

════════════════════════════════════════════════════════
IMPLEMENTATION CHANGES — CRITICAL REQUIREMENT
════════════════════════════════════════════════════════
You MUST include an "implementationChanges" array with 6–12 ready-to-execute competitive actions.
- "proposedChange" must be EXACT rewritten copy, battlecard text, positioning statement, or response script
- "currentState" must reference actual language found on the website (exact quotes)
- No vague suggestions — write the finished deliverable`,

  scoringPrompt: `Score this brand's competitive positioning from 0–100:

90–100: Distinctive — Clear differentiation, sharp messaging, strong competitive moat
75–89:  Solid — Good positioning with some generic elements
60–74:  Generic — Positioning exists but lacks sharpness and differentiation
45–59:  Weak — Vague messaging, could belong to any competitor
0–44:   None — No clear positioning, entirely commodity messaging

Categories (each 0–100):
- Differentiation Clarity: 35% weight
- Audience Specificity: 25% weight
- Message Consistency: 20% weight
- Competitive Distinctiveness: 20% weight`,

  outputFormat: {
    score: 'number (0-100)',
    categoryScores: {
      differentiationClarity: 'number',
      audienceSpecificity: 'number',
      messageConsistency: 'number',
      competitiveDistinctiveness: 'number',
    },
    summary: 'string (Executive summary: overview, biggest opportunity, biggest threat)',
    competitorProfiles: [
      {
        companyName: 'string',
        overview: 'string',
        targetAudience: 'string',
        recentDevelopments: 'string',
        messagingAnalysis: {
          tagline: 'string',
          coreValueProp: 'string',
          keyThemes: ['string'],
          tone: 'string'
        },
        productPositioning: {
          category: 'string',
          claimedDifferentiators: ['string']
        },
        contentStrategy: 'string',
        strengths: ['string'],
        weaknesses: ['string']
      }
    ],
    messagingComparisonMatrix: [
      {
        dimension: 'string (e.g. Primary tagline, Target buyer, Key differentiator, Tone, Value prop)',
        yourCompany: 'string',
        competitorA: 'string',
        competitorB: 'string'
      }
    ],
    contentGapAnalysis: {
      opportunities: ['string'],
      missedThemes: ['string'],
      formatGaps: ['string']
    },
    opportunitiesAndThreats: {
      opportunities: ['string (Positioning gaps to exploit)'],
      threats: ['string (Vulnerabilities or market shifts)']
    },
    battlecard: {
      theirPitch: 'string',
      ourDifferentiators: ['string'],
      objectionHandling: [
        {
          ifProspectSays: 'string',
          respondWith: 'string'
        }
      ],
      landminesToSet: ['string']
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
        title: 'string — e.g. "Rewrite Homepage Tagline to Differentiate from Competitor A"',
        priority: 'string — High / Medium / Low',
        impactScore: 'number 1-100',
        description: 'string — competitive rationale for this change',
        currentState: 'string — EXACT current headline, tagline, or copy from the site',
        proposedChange: 'string — EXACT new copy, ready to publish with no edits required',
        changeType: 'string — one of: messaging / content / positioning / battlecard'
      }
    ],
  },

  buildUserPrompt(crawledData) {
    const competitors = crawledData.perplexityCompetitors ?? null;
    const business    = crawledData.perplexityBusiness    ?? null;
    const industry    = crawledData.perplexityIndustry    ?? null;

    return `Produce a competitive brief for this business:

WEBSITE URL: ${crawledData.url}
INDUSTRY: ${crawledData.industry}

HOMEPAGE CONTENT:
${JSON.stringify(crawledData.homepage || {}, null, 2)}

ABOUT PAGE:
${JSON.stringify(crawledData.aboutPage || {}, null, 2)}

KEY PAGES ANALYSED:
${JSON.stringify(crawledData.pages?.slice(0, 10) || [], null, 2)}

ALL HEADLINES & SUBHEADLINES:
${JSON.stringify(crawledData.headings || [], null, 2)}

CTA TEXT:
${JSON.stringify(crawledData.ctaText || [], null, 2)}

──────────────────────────────────────────
PERPLEXITY WEB RESEARCH — BUSINESS OVERVIEW
(Live web-sourced intelligence)
──────────────────────────────────────────
${business ? JSON.stringify(business, null, 2) : 'Web research unavailable for this business.'}

──────────────────────────────────────────
PERPLEXITY WEB RESEARCH — COMPETITOR LANDSCAPE
(Real competitors found via live web search)
──────────────────────────────────────────
${competitors ? JSON.stringify(competitors, null, 2) : 'Competitor research unavailable.'}

──────────────────────────────────────────
PERPLEXITY WEB RESEARCH — INDUSTRY TRENDS
(Current market trends in the ${crawledData.industry || 'General'} sector)
──────────────────────────────────────────
${industry ? JSON.stringify(industry, null, 2) : 'Industry trend data unavailable.'}

IMPORTANT: The Perplexity sections above contain LIVE WEB DATA. Use this to:
- Reference specific, named competitors and their actual positioning
- Ground recommendations in real market trends (not generic advice)
- Highlight reputation signals and review data if present
- Compare the business's messaging against what competitors say online

Return your competitive brief as valid JSON matching the outputFormat exactly.`;
  },
};

