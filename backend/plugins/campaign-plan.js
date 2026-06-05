// ============================================================
// backend/plugins/campaign-plan.js
// Campaign Plan Plugin — audience, channels, calendar, metrics
// ============================================================

export default {
  id: 'campaign-plan',
  name: 'Campaign Plan',
  description: 'Full brief with audience, channel mix, week-by-week calendar and metrics.',
  estimatedRuntime: 40,
  weight: 0.18,
  maxTokens: 16384,

  systemPrompt: `You are a senior digital marketing strategist with expertise in multi-channel campaign planning.
You specialise in creating data-driven campaign plans for businesses based on the Campaign Framework: Objective, Audience, Message, Channel, Measure.

Your task is to produce a comprehensive 90-day marketing campaign brief based on the business website data provided.

CAMPAIGN BRIEF DELIVERABLES:
1. Campaign Overview: Campaign name, 1-sentence summary, primary SMART objective (Awareness/Consideration/Conversion/Retention), and secondary objectives.
2. Target Audience: Primary and secondary segments (Demographics, Psychographics, Buying Stage), pain points, and where they spend time.
3. Key Messages: Core message, 3-4 supporting messages, proof points, and differentiators.
4. Channel Strategy: Recommended Owned, Earned, and Paid channels with rationale, content formats, effort level, and budget allocation suggestion (%).
5. Content Calendar: Week-by-week (1-12) timeline mapping content pieces to channels and milestones.
6. Content Pieces Needed: Comprehensive list of required assets with descriptions and priority.
7. Success Metrics: Primary KPI and 3-5 secondary KPIs.
8. Budget Allocation: High-level percentage breakdown (e.g. Paid 40%, Content 30%, Events 15%, Tools 10%, Testing 5%).
9. Risks and Mitigations: 2-3 potential risks and mitigation strategies.
10. Next Steps: Immediate action items to kick off the campaign.

IMPORTANT RULES:
- Base channel recommendations on where the target audience spends time, not generic lists.
- Be specific with KPIs — avoid vanity metrics unless justified for awareness.
- Calendar must have specific week numbers and action items.
- Split your Prioritized Action Plan (Recommendations) into Quick Wins (do this week, < 2 hours) and Strategic Investments.
- OUTPUT FORMAT: Respond ONLY with valid JSON matching the exact structure specified.

════════════════════════════════════════════════════════
IMPLEMENTATION CHANGES — CRITICAL REQUIREMENT
════════════════════════════════════════════════════════
You MUST include an "implementationChanges" array with 3–5 deployment-ready campaign assets.
- "proposedChange" must be COMPLETE, ready-to-publish content — actual LinkedIn post copy, actual email subject line + body, actual ad headline + description
- "currentState" describes what the business currently does (or lacks) in that area
- No placeholders. No [INSERT NAME]. No lorem ipsum. Write the actual copy.`,

  scoringPrompt: `Assess the business's current marketing readiness and campaign potential (0–100):

90–100: Launch-ready — Strong brand assets, clear audience, proven channels
75–89:  Ready — Good foundation, minor gaps to address before launch
60–74:  Needs work — Some assets exist, significant strategy gaps
45–59:  Weak foundation — Marketing starts nearly from scratch
0–44:   No foundation — No clear marketing signals found

Categories (each 0–100):
- Content Readiness: 25% weight
- Channel Presence Signals: 25% weight
- Audience Clarity: 25% weight
- Brand Asset Quality: 25% weight`,

  outputFormat: {
    score: 'number (0-100)',
    categoryScores: {
      contentReadiness: 'number',
      channelPresence: 'number',
      audienceClarity: 'number',
      brandAssetQuality: 'number',
    },
    summary: 'string (Executive summary)',
    campaignOverview: {
      campaignName: 'string',
      summary: 'string',
      primaryObjective: 'string (SMART format)',
      secondaryObjectives: ['string']
    },
    targetAudience: {
      primarySegment: 'string',
      secondarySegment: 'string',
      painPoints: ['string'],
      whereTheySpendTime: ['string'],
      buyingStage: 'string'
    },
    keyMessages: {
      coreMessage: 'string',
      supportingMessages: ['string'],
      proofPoints: ['string']
    },
    channelStrategy: [
      {
        channel: 'string',
        rationale: 'string',
        contentFormats: ['string'],
        effortLevel: 'string (Low/Medium/High)',
        budgetAllocationSuggestion: 'string'
      }
    ],
    contentCalendar: [
      {
        week: 'number',
        contentPiece: 'string',
        channel: 'string',
        ownerOrNotes: 'string',
        status: 'string (Planned)'
      }
    ],
    contentPiecesNeeded: [
      {
        assetNameAndType: 'string',
        description: 'string',
        priority: 'string (Must-have/Nice-to-have)',
        timeline: 'string'
      }
    ],
    successMetrics: {
      primaryKPI: 'string',
      secondaryKPIs: ['string'],
      reportingCadence: 'string'
    },
    budgetAllocation: {
      breakdown: ['string'],
      productionVsDistribution: 'string',
      contingencyRecommendation: 'string'
    },
    risksAndMitigations: [
      {
        risk: 'string',
        mitigation: 'string'
      }
    ],
    nextSteps: ['string'],
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
        title: 'string — e.g. "Launch LinkedIn Thought Leadership Series"',
        priority: 'string — High / Medium / Low',
        impactScore: 'number 1-100',
        description: 'string — what this achieves and why now',
        currentState: 'string — what the business currently does or does not do in this area',
        proposedChange: 'string — EXACT campaign brief, post copy, email draft, or ad copy ready to use',
        changeType: 'string — one of: social / email / paid / content / seo / event'
      }
    ]
  },

  buildUserPrompt(crawledData) {
    const industryResearch  = crawledData.perplexityIndustry    ?? null;
    const competitorResearch = crawledData.perplexityCompetitors ?? null;
    const businessResearch   = crawledData.perplexityBusiness    ?? null;

    return `Create a 90-day campaign plan for this business:

WEBSITE URL: ${crawledData.url}
INDUSTRY: ${crawledData.industry}

BUSINESS OVERVIEW (from website):
${JSON.stringify(crawledData.businessSummary || {}, null, 2)}

PRODUCTS/SERVICES IDENTIFIED:
${JSON.stringify(crawledData.productsServices || [], null, 2)}

CURRENT CONTENT TYPES FOUND:
${JSON.stringify(crawledData.contentTypes || [], null, 2)}

EXISTING SOCIAL/CHANNEL LINKS:
${JSON.stringify(crawledData.socialLinks || [], null, 2)}

TARGET GEOGRAPHY SIGNALS:
${JSON.stringify(crawledData.geography || 'Australia', null, 2)}

──────────────────────────────────────────
PERPLEXITY WEB RESEARCH — INDUSTRY TRENDS
(Use these to inform channel choices and campaign themes)
──────────────────────────────────────────
${industryResearch ? JSON.stringify(industryResearch, null, 2) : 'Industry trend data unavailable.'}

──────────────────────────────────────────
PERPLEXITY WEB RESEARCH — COMPETITOR ACTIVITY
(Use these to differentiate the campaign strategy)
──────────────────────────────────────────
${competitorResearch ? JSON.stringify(competitorResearch, null, 2) : 'Competitor data unavailable.'}

──────────────────────────────────────────
PERPLEXITY WEB RESEARCH — BUSINESS REPUTATION
(Use reputation signals to inform audience trust-building tactics)
──────────────────────────────────────────
${businessResearch ? JSON.stringify(businessResearch, null, 2) : 'Business reputation data unavailable.'}

Return your campaign plan as valid JSON matching the outputFormat exactly.`;
  },
};


