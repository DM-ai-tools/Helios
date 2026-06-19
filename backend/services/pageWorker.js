import { Worker } from 'bullmq';
import { connection } from './pageQueue.js';
import redisClient from './redisClient.js';
import { saveSubServicePage } from '../db/queries.js';
import fetch from 'node-fetch';
import ejs from 'ejs';
import fs from 'fs';
import path from 'path';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const IMPL_TTL = 60 * 60 * 24 * 7; // 7 days

// JSON Schema validation keys
const SCHEMA_KEYS = [
  "seo",
  "designProfile",
  "hero",
  "trustIndicators",
  "painPoints",
  "problemSection",
  "comparisonTable",
  "outcomes",
  "services",
  "process",
  "differentiators",
  "platformBadges",
  "caseStudies",
  "testimonials",
  "faqs",
  "cta",
  "footerSeoContent"
];

/**
 * Validates copywriting JSON against the required schema keys.
 */
function validateSchema(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Copywriting data is not an object');
  }
  const missing = [];
  for (const key of SCHEMA_KEYS) {
    if (data[key] === undefined) {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    throw new Error(`JSON is missing required schema keys: ${missing.join(', ')}`);
  }
  return true;
}

/**
 * Extracts and cleans JSON from Claude's response text.
 */
function extractJson(rawText) {
  let cleanJson = rawText.trim();
  const jsonMatch = cleanJson.match(/```json\s*([\s\S]*?)\s*```/i);
  if (jsonMatch) {
    cleanJson = jsonMatch[1];
  } else {
    const braceMatch = cleanJson.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      cleanJson = braceMatch[0];
    }
  }
  return JSON.parse(cleanJson);
}

export const pageWorker = new Worker('generate-page-content', async (job) => {
  const {
    auditId,
    slug,
    userContext,
    existingHtml,
    subServiceName,
    serviceName,
    briefDescription,
    keywords,
    siteUrl,
    industry,
    brandName,
    phoneNumber,
    locations,
    logoUrl,
    navigationLinks,
    footerLinks,
    extractedBrandColors,
    extractedFonts,
    allServices
  } = job.data;

  const statusKey = `sub_service_page_job:${auditId}:${slug}`;
  console.log(`[Page Worker] Job ${job.id} started. Generating page for ${subServiceName}...`);
  await redisClient.setEx(statusKey, 3600, JSON.stringify({ status: 'running', jobId: job.id }));

  try {
    if (!ANTHROPIC_API_KEY) {
      throw new Error('Anthropic API key not configured');
    }

    const keywordList = (keywords || []).join(', ');

    // ─────────────────────────────────────────────────────────────
    // STAGE 1: Copywriting Content Generation via Claude (Single Call)
    // ─────────────────────────────────────────────────────────────
    
    // Static prompt sections for instructions and schema validation
    const staticSystemPrompt = `You are an expert digital marketing copywriter and SEO strategist.
Your task is to write high-depth, authoritative, statistics-rich copywriting for a sub-service landing page.
Do not use placeholders, generic text, or thin sentences. All copy must be extremely detailed, professional, and tailored specifically to this sub-service and industry.

## TARGET SECTIONS, COPYWRITING INSTRUCTIONS & WORD COUNT REQUIREMENTS
You must generate copywriting for the following sections:

1. seo:
   - pageTitle: A high-impact SEO title incorporating primary keywords.
   - metaDescription: A compelling meta description of about 150-160 characters.

2. designProfile:
   - primaryColor: "#f97316"
   - secondaryColor: "#000000"

3. hero:
   - eyebrow: "\${serviceName} Services"
   - h1Title: A high-impact headline containing the primary keyword.
   - subheading: A statistics-rich, authoritative description of 200-300 words highlighting the value proposition, local statistics, and industry-specific terms.
   - trustBadges: exactly 5 realistic, high-impact indicators (e.g., "3.2x Higher CTR", "100% Transparency").

4. trustIndicators:
   - exactly 5 objects, each with {"value": "...", "label": "..."} representing performance metrics or trust signals.

5. problemSection:
   - h2Title: Framing why traditional approaches to \${serviceName} fail local businesses.
   - intro: An authoritative explanation of 300-400 words that details the systemic problems, buyer objections, and Australian/Melbourne industry realities.

6. painPoints:
   - exactly 5 items representing failure scenarios or pain points for different business situations. Each item must contain:
     - scenarioTitle: short title of the failure scenario
     - emoji: 1 relevant text emoji
     - description: a detailed scenario explaining the symptom, root cause, and business/revenue risk. The total combined word count for all 5 pain point descriptions must be 300-400 words.

7. services:
   - exactly 8 dynamic workstream items. Each item must contain:
     - title: name of the workstream (e.g., "Semantic Schema Markup", "Google Maps Citation Audit", etc.)
     - description: a deep, detailed explanation of the methodology, practical scenarios, and direct business impact. The total combined word count for all 8 services descriptions must be 400-500 words.

8. comparisonTable:
   - exactly 6 detailed comparison rows. Each row must compare the manual method vs. advanced method across: Speed/Time, Keyword Reach/Scale, Audit Accuracy, Content Scale & Quality, Algorithm Adaptation, and ROI Timeline. Each row contains:
     - feature: name of the aspect being compared
     - traditional: traditional manual method description
     - ai: our advanced method description

9. outcomes:
   - exactly 3 objects with {"title": "...", "description": "..."} showing measurable business outcomes.

10. process:
    - exactly 7 sequential steps. Each item contains:
      - step: "1" to "7"
      - title: phase name (e.g., "Discovery & Digital Footprint Mapping")
      - emoji: 1 relevant text emoji
      - description: tasks and deliverables in this phase. The total combined word count for all 7 steps must be 250-350 words.

11. differentiators:
    - exactly 6 distinct capability cards. Each item contains:
      - title: short descriptive title
      - emoji: 1 relevant text emoji
      - description: a deep explanation of the capability and its specific value proposition.

12. platformBadges:
    - empty array [] or list of integrations.

13. caseStudies:
    - exactly 1 highly detailed case study object containing:
      - archetype: client vertical or archetype (e.g., "Melbourne Medical Group")
      - challenge: client's original problems (100-150 words)
      - execution: our implementation and optimization work (150-200 words, including industry-specific terminology)
      - metrics: exactly 3 concrete performance metrics (each with a value like "+245%" and a label like "Increase in Local Phone Leads")

14. testimonials:
    - exactly 2 realistic client testimonials. Each testimonial contains:
      - quote: realistic, detailed, quote about the project and returns (80-100 words).
      - author: client name
      - role: client title/role
      - company: company name

15. faqs:
    - exactly 5 detailed FAQs. Each question must mirror a real buyer query and objection. The answers must be highly detailed and authoritative. The total word count of all 5 FAQ answers combined must be 500-700 words.

16. cta:
    - headline: Urgency-framed H2 call-to-action.
    - description: 2-3 sentences highlighting the next steps and booking opportunities.
    - buttonText: action-oriented text.
    - footerSeoBlock: a dense, natural-language paragraph in the footer combining the primary keyword, secondary keywords, and location variations naturally for search engines.

17. footerSeoContent:
    - a duplicate or alternative version of the footer SEO block.

## REQUIRED AUDIT INSIGHTS TO INCLUDE
You must naturally weave the following aspects into the copy:
- Real statistics and metrics (e.g., Maps Pack CTR shifts, local mobile lookup stats).
- Practical scenarios (e.g., Melbourne service-area search behavior, local competitor gap advantages).
- Common buyer objections (e.g., cost, ranking durability, SEO complexity) and clear objections mitigation.
- Industry-specific terminology (e.g., NAP parity, Entity Resolution, Semantic Schema Markup, GMB attributes).

## OUTPUT FORMAT
You must respond ONLY with a valid JSON object matching the JSON structure schema.
Do not include any HTML, CSS, JavaScript, or Markdown outside the JSON.
Ensure all JSON keys and values are enclosed in double quotes. Wrap the JSON in a markdown json code block like \`\`\`json [JSON content] \`\`\`.`;

    const userPrompt = `## INPUTS FOR GENERATION
- siteUrl: ${siteUrl}
- brandName: ${brandName}
- industry: ${industry}
- serviceName: ${serviceName} (Parent Service)
- subServiceName: ${subServiceName} (Active Sub-Service)
- briefDescription: ${briefDescription}
- keywordList: ${keywordList}
- locations: ${locations}
- phoneNumber: ${phoneNumber}
- userContext: ${userContext || 'None provided'}
- existingHtmlSnippet: ${existingHtml ? existingHtml.slice(0, 1000) : 'None available'}

Generate a single copywriting JSON object for ${subServiceName} landing page now. Ensure all word count limits are strictly followed.`;

    let copyData = null;
    let attempts = 3;
    let lastError = null;

    while (attempts > 0) {
      console.log(`[Page Worker] Calling Claude for JSON content (Attempts remaining: ${attempts})...`);
      try {
        const copyResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            // Enable prompt caching and max tokens beta
            'anthropic-beta': 'prompt-caching-2024-07-31,max-tokens-3-5-sonnet-2024-07-15'
          },
          body: JSON.stringify({
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 8192,
            system: [
              {
                type: 'text',
                text: staticSystemPrompt,
                cache_control: { type: 'ephemeral' } // Cache static instructions to save token costs
              }
            ],
            messages: [{ role: 'user', content: userPrompt }],
          }),
        });

        if (!copyResponse.ok) {
          const errText = await copyResponse.text().catch(() => '');
          throw new Error(`Claude Copywriting API error: ${copyResponse.status} — ${errText.slice(0, 200)}`);
        }

        const copyClaudeData = await copyResponse.json();
        const rawCopyText = copyClaudeData?.content?.[0]?.text || '';
        
        // Extract and validate JSON
        copyData = extractJson(rawCopyText);
        validateSchema(copyData);

        console.log(`[Page Worker] ✓ Copywriting JSON successfully generated and validated.`);
        break; // Validation passed, exit loop
      } catch (err) {
        lastError = err;
        console.error(`[Page Worker] Attempt failed: ${err.message}`);
        attempts--;
        if (attempts > 0) {
          // Wait 2 seconds before retrying
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }

    if (!copyData) {
      throw new Error(`JSON Copywriting generation failed after 3 attempts. Last error: ${lastError?.message}`);
    }

    // ─────────────────────────────────────────────────────────────
    // STAGE 2: HTML compilation via EJS Template
    // ─────────────────────────────────────────────────────────────
    console.log(`[Page Worker] Stage 2: Compiling template with copywriting JSON...`);
    const templatePath = path.join(process.cwd(), 'backend/templates/page.ejs');
    if (!fs.existsSync(templatePath)) {
      throw new Error(`EJS template not found at: ${templatePath}`);
    }

    const templateContent = fs.readFileSync(templatePath, 'utf8');

    // Compile and render EJS
    const renderedHtml = ejs.render(templateContent, {
      brandName,
      siteUrl,
      phoneNumber,
      locations,
      serviceName,
      subServiceName,
      logoUrl: logoUrl || null,
      seo: copyData.seo,
      hero: copyData.hero,
      trustIndicators: copyData.trustIndicators || copyData.trustBadges || [],
      problemSection: copyData.problemSection,
      painPoints: copyData.painPoints,
      services: copyData.services,
      servicesSectionTitle: null,
      comparisonTable: copyData.comparisonTable,
      outcomes: copyData.outcomes,
      process: copyData.process,
      differentiators: copyData.differentiators,
      differentiatorsList: null,
      caseStudies: copyData.caseStudies,
      testimonials: copyData.testimonials,
      faqs: copyData.faqs,
      cta: copyData.cta,
      footerSeoContent: copyData.footerSeoContent || copyData.cta.footerSeoBlock || '',
      allServices: allServices || []
    });

    // Save outputs to PostgreSQL and Redis
    console.log(`[Page Worker] Saving generated page to database & Redis...`);
    const pageTitle = copyData.seo?.pageTitle || `${subServiceName} | ${brandName}`;
    const metaDescription = copyData.seo?.metaDescription || briefDescription;

    await saveSubServicePage(auditId, slug, {
      serviceName,
      subServiceName,
      pageTitle,
      metaDescription,
      status: 'pending',
      contentJson: copyData,
      renderedHtml
    });

    console.log(`[Page Worker] ✓ Job completed successfully.`);
    // Set status as completed in Redis so polling Express router returns it
    await redisClient.setEx(statusKey, 3600, JSON.stringify({
      status: 'completed',
      html: renderedHtml,
      pageTitle,
      metaDescription
    }));

    return { success: true };

  } catch (error) {
    console.error(`[Page Worker] Job failed:`, error.message);
    // Set status as failed in Redis
    await redisClient.setEx(statusKey, 3600, JSON.stringify({
      status: 'failed',
      error: error.message
    }));
    throw error;
  }
}, { connection });

pageWorker.on('completed', job => {
  console.log(`[Page Worker] Job ${job.id} completed successfully.`);
});

pageWorker.on('failed', (job, err) => {
  console.log(`[Page Worker] Job ${job.id} failed with error: ${err.message}`);
});
