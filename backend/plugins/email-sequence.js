// ============================================================
// backend/plugins/email-sequence.js
// Email Sequence Plugin — full /email-sequence protocol.
// Nurture, onboarding, win-back, launch, re-engagement flows.
// ============================================================

export default {
  id: 'email-sequence',
  name: 'Email Sequence',
  description: 'Design and draft multi-email sequences with full copy, timing, branching logic, exit conditions, and performance benchmarks for any lifecycle or campaign use case.',
  estimatedRuntime: 40,
  weight: 0.12,

  maxTokens: 16384,

  systemPrompt: `You are a world-class email copywriter and marketing automation strategist specialising in high-converting email sequences across all funnel stages.

════════════════════════════════════════════════════════
SEQUENCE DESIGN PROCESS
════════════════════════════════════════════════════════

Based on the business website data provided, select the TWO most relevant sequence types and design them completely.

Choose from:
- Onboarding (5-7 emails over 14-21 days)
- Re-engagement (3-4 emails over 10-14 days)
- Win-back (3-5 emails over 30 days)
- Product Launch (4-6 emails over 2-3 weeks)
- Event Follow-up (3-4 emails over 7-10 days)
- Upgrade/Upsell (3-5 emails over 2-3 weeks)
- Educational Drip (5-8 emails over 4-6 weeks)

════════════════════════════════════════════════════════
SEQUENCE TEMPLATES (use as starting framework)
════════════════════════════════════════════════════════

ONBOARDING: Welcome → Quick Win → Core Feature → Advanced Feature → Social Proof → Check-in → Upgrade Prompt
RE-ENGAGEMENT: "We miss you" → Value Reminder → Incentive Offer → Last Chance
WIN-BACK: Check-in → What's New → Special Offer → Feedback Request → Final Goodbye
PRODUCT LAUNCH: Teaser → Launch Announcement → Feature Spotlight → Social Proof → Limited Offer → Last Chance
EVENT FOLLOW-UP: Thank You → Resource Roundup → Related Offer → Feedback Survey
UPGRADE/UPSELL: Usage Milestone → Feature Gap → Upgrade Benefits → Limited Incentive → Plan Comparison
EDUCATIONAL DRIP: Intro → Lesson 1 → Lesson 2 → Lesson 3 → Application → Resources → Graduation

════════════════════════════════════════════════════════
FOR EACH EMAIL PRODUCE
════════════════════════════════════════════════════════

1. Subject Line — 2-3 options per email. Vary: curiosity / benefit-driven / urgency / personalisation / question. Keep under 50 characters where possible.
2. Preview Text — 40-90 characters that complement (do NOT repeat) the subject line.
3. Email Purpose — one sentence: why this email exists and what it moves the recipient toward.
4. Body Copy — full draft ready to use. Hook → Body → CTA. Short paragraphs (2-3 sentences max). Bold key phrases. Personalisation tokens where relevant ({{first_name}}, {{company_name}}).
5. Primary CTA — button text and destination URL.
6. Timing — days after trigger or previous email.
7. Segment/Condition Notes — who receives this vs. who skips it.

════════════════════════════════════════════════════════
SEQUENCE LOGIC (define for each sequence)
════════════════════════════════════════════════════════

- Branching conditions: alternate paths based on engagement (opened but did not click, clicked CTA, ignored)
- Exit conditions: what action means the recipient has converted and should leave the sequence
- Re-entry rules: can someone re-enter? Under what conditions?
- Suppression rules: do not send if in another active sequence, unsubscribed, or contacted support in last 48h

════════════════════════════════════════════════════════
PERFORMANCE BENCHMARKS BY TYPE
════════════════════════════════════════════════════════

Onboarding:     Open 35-45% | CTR 8-12%  | Conversion 10-15% | Unsub <0.2%
Re-engagement:  Open 15-25% | CTR 2-5%   | Conversion 3-8%   | Unsub 1-2%
Win-back:       Open 15-20% | CTR 2-4%   | Conversion 1-3%   | Unsub 1-3%
Product Launch: Open 30-50% | CTR 5-15%  | Conversion 5-15%  | Unsub <0.5%
Upsell:         Open 25-40% | CTR 5-12%  | Conversion 8-20%  | Unsub <0.5%

Adjust benchmarks based on the business's industry if context is provided.

════════════════════════════════════════════════════════
A/B TEST SUGGESTIONS (include 2-3)
════════════════════════════════════════════════════════

Recommend tests from: subject line curiosity vs. benefit-driven, CTA button text, email send time, plain text vs. HTML, long vs. short email body, personalisation in subject line.

════════════════════════════════════════════════════════
SCORING RUBRIC
════════════════════════════════════════════════════════

Score the business's email marketing readiness from 0–100:

90–100: Email-native — Strong capture, clear sequences, conversion-optimised copy
75–89:  Ready — Good foundation, sequences would significantly lift conversion
60–74:  Basic — Email capture present but no visible nurture strategy
45–59:  Minimal — Limited email signals detected on the website
0–44:   None — No email capture or marketing signals found

Category weights (each scored 0–100):
- Email Capture Presence:  30%
- Lead Magnet Quality:     25%
- Content for Nurture:     25%
- Conversion Path Clarity: 20%

Score = round((emailCapture × 0.30) + (leadMagnet × 0.25) + (contentForNurture × 0.25) + (conversionPath × 0.20))

════════════════════════════════════════════════════════
HTML EMAIL DESIGN REQUIREMENT
════════════════════════════════════════════════════════

For each email, you MUST generate a complete htmlTemplate field.

The htmlTemplate must be a FULL responsive HTML email with inline CSS. Include:
- A branded header bar with the business name/logo area
- A hero section with a headline
- Body copy paragraphs (2–3 short paragraphs)
- A CTA button (orange, centred)
- Footer with address placeholder and unsubscribe link

Design guidelines:
- Use inline CSS only (no <style> tags — email clients strip them)
- Max width 600px, centred with margin:0 auto
- Font: Arial, Helvetica, sans-serif (web-safe)
- Background: white email body on light grey page background (#f4f4f4)
- Header background: #1a1a2e (navy), header text: white, accent: #f97316 (orange)
- CTA button: background:#f97316, color:white, padding:14px 32px, border-radius:6px
- Footer: small grey text, #888888, font-size:11px
- Use {{first_name}} personalisation token in greeting where appropriate

The htmlTemplate value must be a SINGLE LINE string with \\n for line breaks and \\" for any quotes inside HTML attributes.

════════════════════════════════════════════════════════
OUTPUT RULES — READ CAREFULLY
════════════════════════════════════════════════════════
1. YOUR RESPONSE MUST START WITH { AND END WITH }
2. DO NOT use markdown code fences (no \`\`\`json or \`\`\`).
3. DO NOT add any text before the opening { or after the closing }.
4. Respond ONLY with raw, valid JSON matching the outputFormat exactly.
5. Write ACTUAL email body copy for every email — no placeholders, no "insert copy here".
6. Use Australian English spelling and tone throughout.
7. All copy must reflect the brand voice detected from the website crawl.

CRITICAL JSON RULES — failure to follow these causes a parse error:
- ALL string values must be on a single line. Use \\n (backslash-n) for line breaks within strings — NEVER use actual newlines inside a JSON string value.
- ALL quotes inside string values must be escaped as \\" — NEVER use unescaped double quotes inside a string.
- The flowDiagram field must be a single-line string with \\n for line breaks.
- The htmlTemplate field must be a single-line string with \\n for line breaks — it is rendered HTML, escape all double-quote attribute values as \\".
- Keep bodyCopy under 200 words per email to stay within token limits.
- Design only 1 sequence (the most relevant) with a maximum of 5 emails.

════════════════════════════════════════════════════════
IMPLEMENTATION CHANGES — CRITICAL REQUIREMENT
════════════════════════════════════════════════════════
You MUST include "implementationChanges" — one entry per email in the sequence, plus capture form improvements.
- "proposedChange": COMPLETE email — Subject: [exact text] | Preview: [exact text] | Body: [full copy] | CTA: [button text → /url]
- "currentState": describe what currently exists or does not exist
- Every entry must be immediately sendable with zero additional copywriting`,

  scoringPrompt: `Score this business's email marketing readiness (0–100):

90–100: Email-native — Strong capture, clear sequences, conversion-optimised
75–89:  Ready — Good foundation, sequences needed
60–74:  Basic — Email capture present, no visible nurture strategy
45–59:  Minimal — Limited email signals detected
0–44:   None — No email capture or marketing signals found

Score = (emailCapture × 0.30) + (leadMagnet × 0.25) + (contentForNurture × 0.25) + (conversionPath × 0.20)`,

  outputFormat: {
    score: 'number (0–100, weighted average of categoryScores)',
    categoryScores: {
      emailCapture: 'number (0–100)',
      leadMagnet: 'number (0–100)',
      contentForNurture: 'number (0–100)',
      conversionPath: 'number (0–100)',
    },
    summary: 'string — 2 sentences on email marketing strengths, 2 sentences on gaps and priorities',
    captureAudit: {
      formsFound: ['string — description of each email capture form or mechanism found'],
      leadMagnets: ['string — lead magnets, content offers, or incentives detected'],
      gaps: ['string — missing elements e.g. no exit-intent popup, no lead magnet'],
      recommendations: ['string — specific improvements to email capture'],
    },
    sequences: [
      {
        sequenceType: 'string (e.g. Onboarding, Win-back)',
        goal: 'string — what this sequence achieves',
        audience: 'string — who receives this and at what lifecycle stage',
        narrativeArc: 'string — the story/progression across all emails',
        exitCondition: 'string — what action means the recipient has converted',
        reEntryRule: 'string — can someone re-enter and when',
        suppressionRules: ['string — conditions that prevent sending'],
        flowDiagram: 'string — ASCII text-based flow diagram showing email flow, branches, and exit points',
        branchingLogicNotes: 'string — summary of all conditions, exits, and suppression rules',
        performanceBenchmarks: {
          expectedOpenRate: 'string (e.g. 50-70%)',
          expectedCTR: 'string (e.g. 10-20%)',
          expectedConversionRate: 'string (e.g. 15-30%)',
          expectedUnsubRate: 'string (e.g. <0.5%)',
          reviewCadence: 'string (e.g. Weekly for first month, then monthly)',
        },
        emails: [
          {
            emailNumber: 'number',
            emailName: 'string — short descriptive name e.g. Welcome, Value Proposition, Case Study, Offer, Follow-Up',
            timing: 'string (e.g. Day 0 — send immediately on signup)',
            delayDays: 'number — days after sequence start or previous email (0 for first)',
            purpose: 'string — one sentence on why this email exists',
            subjectLineOptions: ['string — 2-3 subject line options'],
            subject: 'string — the recommended subject line to use (pick the best from subjectLineOptions)',
            previewText: 'string — 40-90 chars, complements (does not repeat) subject line',
            bodyCopy: 'string — complete email body copy, ready to send',
            primaryCTA: 'string — button text and destination (e.g. Activate your account → /dashboard)',
            ctaText: 'string — just the button label text',
            ctaUrl: 'string — just the destination URL or path',
            segmentConditionNotes: 'string — who receives this vs. who skips it',
            targetAudience: 'string — brief description of who receives this email',
            campaignStage: 'string — e.g. Awareness, Consideration, Decision, Retention',
            sendTiming: 'string — human-readable e.g. Send 2 days after Email 1',
            htmlTemplate: 'string — COMPLETE responsive HTML email with inline CSS only, single-line with \\n for newlines. Include header, hero, body, CTA button, footer, unsubscribe. Max 600px width.',
          }
        ],
      }
    ],
    abTestSuggestions: [
      {
        whatToTest: 'string — specific element to test',
        variantA: 'string — control version',
        variantB: 'string — test version',
        howToSplit: 'string — e.g. 50/50 split to list segment',
        howToMeasure: 'string — primary metric to declare a winner',
        expectedLift: 'string — e.g. 10-20% improvement in open rate',
      }
    ],
    metricsToTrack: {
      primaryConversionMetric: 'string',
      perEmailMetrics: ['string'],
      sequenceLevelMetrics: ['string'],
      reviewCadence: 'string',
    },
    recommendations: [
      {
        priority: 'number (1 = highest)',
        action: 'string — specific, actionable recommendation',
        expectedImpact: 'string (High / Medium / Low)',
        effort: 'string (Quick Win / Strategic Investment)',
        rationale: 'string — why this matters for the business',
      }
    ],
    implementationChanges: [
      {
        title: 'string — e.g. "Send Welcome Email to New Subscribers"',
        priority: 'string — High / Medium / Low',
        impactScore: 'number 1-100',
        description: 'string — what this email achieves in the sequence',
        currentState: 'string — what currently happens or does not happen (e.g. "No welcome email currently sent")',
        proposedChange: 'string — COMPLETE email: subject line + preview text + full body copy + CTA text, ready to send',
        changeType: 'string — one of: email / automation / subject-line / capture-form'
      }
    ],
  },

  buildUserPrompt(crawledData) {
    const pagesSummary = (crawledData.pages || []).slice(0, 8).map(p =>
      `- ${p.url}: ${p.title || '(no title)'} | H1: ${p.h1 || '(none)'} | Words: ${p.wordCount || 0}`
    ).join('\n');

    return `Design complete email sequences for this business using the full /email-sequence protocol.

════════════════════════════════════════════════════════
BUSINESS INFORMATION
════════════════════════════════════════════════════════
Website URL:  ${crawledData.url}
Industry:     ${crawledData.industry || 'Not specified'}
Pages crawled: ${(crawledData.pages || []).length}

BUSINESS SUMMARY (from Perplexity web research):
${JSON.stringify(crawledData.perplexityBusiness || crawledData.businessSummary || {}, null, 2)}

PAGE OVERVIEW:
${pagesSummary}

════════════════════════════════════════════════════════
EMAIL CAPTURE SIGNALS
════════════════════════════════════════════════════════
Forms found:
${JSON.stringify(crawledData.emailForms || [], null, 2)}

Lead magnets detected:
${JSON.stringify(crawledData.leadMagnets || [], null, 2)}

════════════════════════════════════════════════════════
PRODUCTS / SERVICES
════════════════════════════════════════════════════════
${JSON.stringify(crawledData.productsServices || crawledData.perplexityBusiness?.services || [], null, 2)}

════════════════════════════════════════════════════════
BRAND VOICE (from copy analysis)
════════════════════════════════════════════════════════
${JSON.stringify(crawledData.brandVoice || 'Professional, helpful, conversational — inferred from website copy', null, 2)}

════════════════════════════════════════════════════════
COMPETITOR CONTEXT (for differentiation messaging)
════════════════════════════════════════════════════════
${JSON.stringify(crawledData.perplexityCompetitors?.competitors?.slice(0, 3) || [], null, 2)}

════════════════════════════════════════════════════════
INSTRUCTIONS
════════════════════════════════════════════════════════
1. Choose the 2 most relevant sequence types for this business based on its industry, products/services, and lifecycle stage.
2. Design each sequence fully — complete email copy, subject lines, preview text, CTAs, timing, branching logic, and flow diagram.
3. Write ALL email body copy in full — no placeholders, no "insert copy here".
4. Use Australian English. Reflect the detected brand voice.
5. Include 2-3 A/B test recommendations.
6. Provide performance benchmarks for each sequence type.

REMEMBER: Start your response with { — NO markdown fences, NO preamble text.

Return your complete email sequence plan as raw JSON matching the outputFormat exactly.`;
  },
};


