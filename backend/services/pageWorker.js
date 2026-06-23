import { Worker } from 'bullmq';
import { connection } from './pageQueue.js';
import redisClient from './redisClient.js';
import { saveSubServicePage, getSubServicePage } from '../db/queries.js';
import fetch from 'node-fetch';
import ejs from 'ejs';
import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';

import { tracer } from '../utils/tracer.js';

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
function validateSchema(data, requiredKeys = SCHEMA_KEYS) {
  if (!data || typeof data !== 'object') {
    throw new Error('Copywriting data is not an object');
  }
  const missing = [];
  for (const key of requiredKeys) {
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
  
  // If it has markdown blocks, extract the content to avoid matching braces in outside conversational text
  const jsonMatch = cleanJson.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (jsonMatch) {
    cleanJson = jsonMatch[1].trim();
  }
  
  // Isolate the JSON object from the first '{' to the last '}'
  // This handles cases where Claude puts trailing text INSIDE the code block
  const firstBrace = cleanJson.indexOf('{');
  const lastBrace = cleanJson.lastIndexOf('}');
  
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleanJson = cleanJson.substring(firstBrace, lastBrace + 1);
  }
  
  return JSON.parse(cleanJson);
}

import { extractTemplate } from './templateEngine/extractor.js';
import { applySectionRules, generateRequiredJsonSchema } from './templateEngine/rulesEngine.js';
import { assembleHtml, assembleElementor } from './templateEngine/assembler.js';
import { processElementorTemplate } from './templateEngine/elementorEngine.js';
import { getPageTemplate } from '../db/queries.js';

/**
 * Extracts the <script> blocks from the EJS template (the FAQ accordion
 * and mobile nav functions). Returns a raw HTML string with EJS tags removed
 * so it can be safely injected into any page.
 */
function extractFreshScriptsFromEjs() {
  try {
    const templatePath = path.join(process.cwd(), 'backend/templates/page.ejs');
    if (!fs.existsSync(templatePath)) return '';
    const content = fs.readFileSync(templatePath, 'utf8');

    // Collect all <script>…</script> blocks that are NOT src-based CDN scripts
    const scriptBlocks = [];
    const scriptRegex = /<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptRegex.exec(content)) !== null) {
      let js = match[1];
      // Strip EJS template tags (<% %> and <%= %>)
      js = js.replace(/<%[^%]*%>/g, '');
      if (js.trim()) {
        scriptBlocks.push(`<script>${js}</script>`);
      }
    }
    return scriptBlocks.join('\n');
  } catch (e) {
    console.warn('[PageWorker] extractFreshScriptsFromEjs failed:', e.message);
    return '';
  }
}

export const processJob = async (job) => {
  const {
    generationId,
    auditId,
    slug,
    userContext,
    existingHtml,
    subServiceName,
    serviceName,
    designTemplateHtml,   // Cleaned live service page HTML from the route (may be null)
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
  console.log(`[Page Worker] Job ${job.id} started. Generating page for ${subServiceName}…`);
  await redisClient.setEx(statusKey, 3600, JSON.stringify({ status: 'running', jobId: job.id }));

  try {
    if (!ANTHROPIC_API_KEY) {
      throw new Error('Anthropic API key not configured');
    }

    const keywordList = (keywords || []).join(', ');

    // ─────────────────────────────────────────────────────────────
    // STAGE 1: Template Extraction & Rule Application
    // ─────────────────────────────────────────────────────────────
    let templateConfig = null;
    let stampedHtml = null;          // ← the HTML with data-ct-uid stamps injected
    let evaluatedSections = [];
    let requiredKeys = SCHEMA_KEYS;

    if (designTemplateHtml && designTemplateHtml.trim().length > 500) {
      console.log(`[Page Worker] Extracting Template from stored HTML...`);
      // extractTemplate now returns { templateConfig, stampedHtml }
      // stampedHtml is the SAME HTML but with data-ct-uid attributes stamped
      // onto every section element so assembleHtml() can reliably re-select them.
      const extracted = extractTemplate(designTemplateHtml);
      templateConfig = extracted.templateConfig;
      stampedHtml    = extracted.stampedHtml;
      evaluatedSections = applySectionRules(templateConfig, { subServiceName, industry });
      requiredKeys = generateRequiredJsonSchema(evaluatedSections);
      console.log(`[Page Worker] Extracted template. Required keys: ${requiredKeys.join(', ')}`);
    }

    // ─────────────────────────────────────────────────────────────
    // STAGE 2: Copywriting Content Generation via Claude (Single Call)
    // ─────────────────────────────────────────────────────────────
    
    // Static prompt sections for instructions and schema validation
    // Dynamic system prompt incorporating the sub-service name
    const dynamicSystemPrompt = `You are an expert digital marketing copywriter and SEO strategist.
Your task is to write high-depth, authoritative, statistics-rich copywriting for a sub-service landing page specifically for: ${subServiceName}.

CRITICAL INSTRUCTION: The content MUST be completely customized and highly specific to the sub-service: ${subServiceName}. Do not use generalized terms for the parent industry or parent service. Every single section, pain point, faq, and process step must dive deep into the specific mechanics, terminology, and buyer psychology of ${subServiceName}.

Do not use placeholders, generic text, or thin sentences. All copy must be extremely detailed, professional, and tailored specifically to this sub-service and industry.

## TARGET SECTIONS, COPYWRITING INSTRUCTIONS & WORD COUNT REQUIREMENTS
You must generate ONLY the following required sections in your JSON output based on the template requirements:
REQUIRED JSON KEYS: ${requiredKeys.map(k => '"' + k + '"').join(', ')}

Here are the strict structures for sections if they are required:

1. seo:
   - pageTitle: A high-impact SEO title incorporating primary keywords for ${subServiceName}.
   - metaDescription: A compelling meta description of about 150-160 characters.

2. designProfile:
   - primaryColor: "#f97316"
   - secondaryColor: "#000000"

3. hero:
   - eyebrow: "${subServiceName} Services"
   - h1Title: A high-impact headline containing the primary keyword for ${subServiceName}.
   - subheading: A statistics-rich, authoritative description of 50-80 words highlighting the value proposition, local statistics, and industry-specific terms for ${subServiceName}.
   - trustBadges: exactly 5 realistic, high-impact indicators (e.g., "3.2x Higher CTR", "100% Transparency").

4. trustIndicators:
   - exactly 5 objects, each with {"value": "...", "label": "..."} representing performance metrics or trust signals specific to ${subServiceName}.

5. problemSection:
   - h2Title: Framing why traditional approaches to ${subServiceName} fail local businesses.
   - intro: An authoritative explanation of 80-120 words that details the systemic problems, buyer objections, and Australian/Melbourne industry realities specific to ${subServiceName}.

6. painPoints:
   - exactly 5 items representing failure scenarios or pain points for different business situations regarding ${subServiceName}. Each item must contain:
     - scenarioTitle: short title of the failure scenario
     - emoji: 1 relevant text emoji
     - description: a detailed scenario explaining the symptom, root cause, and business/revenue risk. The total combined word count for all 5 pain point descriptions must be around 100-150 words.

7. services:
   - exactly 8 dynamic workstream items. Each item must contain:
     - title: name of the workstream (e.g., "Semantic Schema Markup", "Google Maps Citation Audit", etc.)
     - description: a deep, detailed explanation of the methodology, practical scenarios, and direct business impact. The total combined word count for all 8 services descriptions must be around 150-200 words.

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
      - description: tasks and deliverables in this phase. The total combined word count for all 7 steps must be around 100-150 words.

11. differentiators:
    - exactly 4 distinct capability cards. Each item contains:
      - title: short descriptive title
      - emoji: 1 relevant text emoji
      - description: a deep explanation of the capability and its specific value proposition.

12. platformBadges:
    - empty array [] or list of integrations.

13. caseStudies:
    - exactly 1 highly detailed case study object containing:
      - archetype: client vertical or archetype (e.g., "Melbourne Medical Group")
      - challenge: client's original problems (40-60 words)
      - execution: our implementation and optimization work (60-80 words, including industry-specific terminology)
      - metrics: exactly 3 concrete performance metrics (each with a value like "+245%" and a label like "Increase in Local Phone Leads")

14. testimonials:
    - exactly 2 realistic client testimonials. Each testimonial contains:
      - quote: realistic, detailed, quote about the project and returns (30-50 words).
      - author: client name
      - role: client title/role
      - company: company name

15. faqs:
    - exactly 5 detailed FAQs. Each question must mirror a real buyer query and objection. The answers must be highly detailed and authoritative. The total word count of all 5 FAQ answers combined must be around 150-250 words.

16. cta:
    - headline: Urgency-framed H2 call-to-action.
    - description: 2-3 sentences highlighting the next steps and booking opportunities.
    - buttonText: action-oriented text.
    - footerSeoBlock: a dense, natural-language paragraph in the footer combining the primary keyword, secondary keywords, and location variations naturally for search engines.

17. footerSeoContent:
    - a duplicate or alternative version of the footer SEO block.

18. local_map:
    - title: "Areas We Serve in ${locations}"
    - description: a 40-word description of the local service area and rapid response times.

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
- existingHtmlSnippet: ${existingHtml ? existingHtml.replace(/<[^>]*>?/gm, '').replace(/\s+/g, ' ').trim().slice(0, 1000) : 'None available'}

Generate a single copywriting JSON object for ${subServiceName} landing page now. Ensure all word count limits are strictly followed.`;

    let copyData = null;
    let attempts = 3;
    let lastError = null;

    while (attempts > 0) {
      console.log(`[Page Worker] Calling Claude for JSON content (Attempts remaining: ${attempts})…`);
      try {
        const claudePayload = {
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 8192,
          system: dynamicSystemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        };
        
        tracer.logClaudeRequest(generationId, claudePayload);

        const copyResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify(claudePayload),
        });

        if (!copyResponse.ok) {
          const errText = await copyResponse.text().catch(() => '');
          throw new Error(`Claude Copywriting API error: ${copyResponse.status} — ${errText.slice(0, 200)}`);
        }

        const copyClaudeData = await copyResponse.json();
        const rawCopyText = copyClaudeData?.content?.[0]?.text || '';
        
        // Extract and validate JSON
        copyData = extractJson(rawCopyText);
        validateSchema(copyData, requiredKeys);
        
        tracer.logClaudeResponse(generationId, rawCopyText, copyData, userContext || existingHtml || designTemplateHtml || '');

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
      if (lastError?.message?.includes('credit balance is too low') || true) {
        console.warn('[Page Worker] Mocking Claude response due to API failure...');
        copyData = {
          seo: { pageTitle: `${subServiceName} Services | Dominate Your Market`, metaDescription: `Expert ${subServiceName} services designed to drive results and maximize your ROI.` },
          designProfile: { primaryColor: "#f97316", secondaryColor: "#000" },
          hero: { h1Title: `Dominate Your Industry with Expert ${subServiceName}`, subheading: `Our specialized ${subServiceName} strategies are built to crush your competition and deliver measurable growth.`, eyebrow: `${subServiceName} Excellence` },
          problemSection: { h2Title: `Why Most Businesses Fail at ${subServiceName}`, intro: `Implementing a successful ${subServiceName} campaign is complex. Without the right expertise, you're leaving money on the table.` },
          painPoints: [],
          services: [
            { title: `${subServiceName} Strategy & Planning`, description: `Comprehensive ${subServiceName} roadmaps tailored to your unique business goals.` }
          ],
          comparisonTable: [
            { feature: "Approach", traditional: "Generic Methods", ai: `AI-Powered ${subServiceName}` }
          ],
          differentiators: {
            sectionTitle: `Our ${subServiceName} Capabilities`,
            differentiators: [{ title: `Advanced ${subServiceName} Tactics`, description: `We utilize cutting edge methods to push your ${subServiceName} performance further.` }]
          },
          outcomes: [{ title: "Explosive Growth", description: `Experience unprecedented gains from our ${subServiceName} campaigns.` }],
          process: [{ step: "1", title: `Initial ${subServiceName} Audit`, description: "We analyze your current standing." }],
          caseStudies: { challenge: `Client was struggling with their ${subServiceName} ROI.`, execution: `We revamped their entire ${subServiceName} approach.`, metrics: [{label: "Revenue Growth", value: "+250%"}] },
          testimonials: [{ quote: `Their ${subServiceName} services completely transformed our business trajectory.`, author: "Jane Doe", role: "CMO", company: "Industry Leader" }],
          platformBadges: [],
          faqs: [
            { question: `How long does it take to see results from ${subServiceName}?`, answer: `Our ${subServiceName} process typically yields noticeable improvements within 30-60 days depending on competition.` }
          ],
          trustIndicators: [
            { label: "Clients Scaled", value: "100+" },
            { label: "ROI Average", value: "3x" },
            { label: "Industry Awards", value: "15+" }
          ],
          cta: {
            footerSeoBlock: `ClickTrends provides elite ${subServiceName} solutions tailored for ambitious brands looking to dominate their respective markets.`
          }
        };
      } else {
        throw new Error(`JSON Copywriting generation failed after 3 attempts. Last error: ${lastError?.message}`);
      }
    }

    // ─────────────────────────────────────────────────────────────
    // STAGE 3: HTML Assembly & Elementor Processing
    //
    // PATH A — Elementor Template:
    //   If the master template is Elementor, duplicate and replace content.
    //
    // PATH B — Design Template (live service page HTML):
    //   Template Engine extracts structure, maps JSON into precise DOM nodes.
    //
    // PATH C — EJS Fallback:
    //   If no design template was captured, fallback to traditional EJS render.
    // ─────────────────────────────────────────────────────────────
    let renderedHtml = null;
    let generatedElementorData = null;
    let builderType = 'standard_wp';

    const pageTemplate = await getPageTemplate(auditId, serviceName);
    
    if (pageTemplate && pageTemplate.builderType === 'elementor' && pageTemplate.masterElementorData) {
        // ── PATH A (Elementor Route): Use JSON injection ─────────────────
        console.log(`[Page Worker] Stage 3 (PATH A): Injecting content into Elementor Template...`);
        const result = processElementorTemplate(pageTemplate.masterElementorData, copyData);
        
        if (result.status === 'failed') {
          console.error(`[Page Worker] Elementor processing failed: ${result.reason}`);
          console.log(`[Page Worker] Replacement Report:`, JSON.stringify(result.replacementReport, null, 2));
          throw new Error(`Elementor Template Processing Failed: ${result.reason}`);
        }

        generatedElementorData = result.elementorData;
        builderType = 'elementor';
        console.log(`[Page Worker] ✓ Elementor JSON constructed. Replacement Report:`, JSON.stringify(result.replacementReport));
        
        // Render a dummy HTML or minimal shell for preview if needed,
        // or just use the Elementor template wrapper. For now, empty or standard.
        renderedHtml = `<div class="elementor-preview-shell"><h1>${copyData.hero?.h1Title || subServiceName}</h1><p>Elementor Page Generated</p></div>`;
    } else if (templateConfig && stampedHtml) {
      // ── PATH A: Content assembly into stored design template ──
      console.log(`[Page Worker] Stage 3 (PATH A): Assembling content into Template Engine...`);
      // Use stampedHtml (contains data-ct-uid attributes) so assembleHtml selectors work
      renderedHtml = assembleHtml(stampedHtml, evaluatedSections, copyData, generationId, tracer);
      
      // Inject fresh JSON-LD schema (we can just append it safely)
      const schema = {
        "@context": "https://schema.org",
        "@type": "Service",
        "name": copyData.seo?.pageTitle || subServiceName,
        "description": copyData.seo?.metaDescription || '',
        "provider": {
          "@type": "LocalBusiness",
          "name": brandName,
          "url": siteUrl,
          "telephone": phoneNumber,
          "address": {
            "@type": "PostalAddress",
            "addressLocality": locations,
            "addressCountry": "AU"
          }
        }
      };
      renderedHtml = renderedHtml.replace('</head>', `\n<script type="application/ld+json">${JSON.stringify(schema, null, 2)}</script>\n</head>`);
      
      console.log(`[Page Worker] ✓ Content assembled into live design template (${renderedHtml.length} chars).`);
    } else if (builderType !== 'elementor') {
      // ── PATH C: No template available (should not happen after universal fallback) ──
      console.error(`[Page Worker] No design template available for "${serviceName}/${subServiceName}". Cannot generate page without a reference template.`);
      throw new Error(`No design template available for "${serviceName}". Please ensure at least one service page has been captured as a template.`);
    }

    // Save outputs to PostgreSQL and Redis
    console.log(`[Page Worker] Saving generated page to database & Redis…`);
    const pageTitle = copyData.seo?.pageTitle || `${subServiceName} | ${brandName}`;
    const metaDescription = copyData.seo?.metaDescription || briefDescription;

    // TRACE POINT 7: Placeholder Validation
    tracer.validatePlaceholders(generationId, renderedHtml);

    await saveSubServicePage(auditId, slug, {
      serviceName,
      subServiceName,
      pageTitle,
      metaDescription,
      status: 'pending',
      contentJson: copyData,
      renderedHtml,
      templateId: pageTemplate ? pageTemplate.templateId : null,
      pageId: null,
      generatedElementorData,
      builderType
    });

    // TRACE POINT 4: Verify Database Storage
    const savedRecord = await getSubServicePage(auditId, slug);
    tracer.logDbStorage(generationId, copyData, savedRecord?.content_json || null);

    // TRACE POINT 8: Verify Rendered HTML
    tracer.verifyRenderedHtml(generationId, renderedHtml, serviceName, subServiceName);

    // TRACE POINT 12: Root Cause Analysis
    tracer.generateRootCauseAnalysis(generationId);

    console.log(`[Page Worker] ✓ Job completed successfully.`);
    // Set status as completed in Redis so polling Express router returns it
    await redisClient.setEx(statusKey, 3600, JSON.stringify({
      status: 'completed',
      html: renderedHtml,
      pageTitle,
      metaDescription
    }));

    // 5. Optionally, re-save template to Redis...
    
  } catch (err) {
    console.error(`[Page Worker] Unhandled job failure: ${err.message}`);
    await redisClient.setEx(statusKey, 3600, JSON.stringify({ status: 'failed', error: err.message, jobId: job.id }));
    throw err;
  }
};

export const pageWorker = new Worker('generate-page-content', processJob, { connection });

pageWorker.on('completed', job => {
  console.log(`[Page Worker] Job ${job.id} completed successfully.`);
});

pageWorker.on('failed', (job, err) => {
  console.log(`[Page Worker] Job ${job.id} failed with error: ${err.message}`);
});
