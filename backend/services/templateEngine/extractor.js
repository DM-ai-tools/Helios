import * as cheerio from 'cheerio';

const SECTION_KEYWORDS = {
  hero: ['h1'], // identified via H1 check in caller — fallback keywords below
  trust_indicators: ['trusted by', 'featured in', 'as seen on', 'partners', 'accredited'],
  pain_points: ['tired of', 'frustrated', 'struggling', 'challenges', 'pain point', 'problem with'],
  problemSection: ['the problem', 'why you need', 'why traditional', 'issues with'],
  services: ['what we do', 'our services', 'framework', 'capabilities', 'workstream'],
  comparisonTable: ['vs', 'traditional', 'agencies vs', 'comparison', 'versus', 'manual method'],
  outcomes: ['results', 'expect', 'outcomes', 'what you get'],
  process: ['how it works', 'our process', 'timeline', 'steps', 'step 1', 'how we work'],
  case_studies: ['case study', 'results we delivered', 'proof', 'client results'],
  testimonials: ['what clients say', 'testimonials', 'reviews', 'what our clients'],
  faqs: ['faq', 'frequently asked', 'common questions', 'questions about'],
  cta: ['ready to', 'get started', 'book a call', 'contact us', 'speak to', 'claim your']
};

/**
 * Heuristically determines the section type based on its text content.
 */
function classifySectionText(text) {
  if (!text || text.trim().length === 0) return 'unknown';
  const lowerText = text.toLowerCase();

  for (const [type, keywords] of Object.entries(SECTION_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lowerText.includes(keyword)) {
        return type;
      }
    }
  }
  return 'unknown';
}

/**
 * Extracts sections from Elementor JSON data
 */
function extractElementorSections(elementorData) {
  const sections = [];
  let order = 0;
  
  function traverse(elements) {
    if (!Array.isArray(elements)) return;
    for (const el of elements) {
      if (el.elType === 'section') {
        // Check if this section is just a wrapper containing inner sections
        let hasInnerSections = false;
        function checkInner(node) {
          if (node.elements) {
            for (const child of node.elements) {
              if (child.elType === 'section') {
                hasInnerSections = true;
                return;
              }
              checkInner(child);
            }
          }
        }
        checkInner(el);

        if (hasInnerSections) {
          traverse(el.elements);
          continue;
        }

        // Collect all text from this section to classify it
        const textNodes = [];
        function collectText(node) {
          if (node.settings && node.settings.editor) {
            textNodes.push(node.settings.editor);
          }
          if (node.settings && node.settings.title) {
            textNodes.push(node.settings.title);
          }
          if (node.elements) {
            node.elements.forEach(collectText);
          }
        }
        collectText(el);
        const sectionText = textNodes.join(' ');
        
        const type = classifySectionText(sectionText);
        sections.push({
          sectionId: el.id,
          sectionType: type,
          order: order++,
          required: ['hero', 'services', 'cta'].includes(type),
          visibilityRules: [],
          rawElement: el // keep reference for later assembly
        });
      } else if (el.elements) {
        traverse(el.elements);
      }
    }
  }
  
  traverse(elementorData);
  // Ensure the first section is marked as hero if unknown
  if (sections.length > 0 && sections[0].sectionType === 'unknown') {
    sections[0].sectionType = 'hero';
    sections[0].required = true;
  }
  return sections;
}

/**
 * Extracts sections from standard DOM HTML.
 * Stamps a unique `data-ct-uid` attribute onto each candidate section element
 * and returns BOTH the section metadata AND the modified HTML so that
 * assembleHtml() can reliably re-select every section.
 *
 * @returns {{ sections: Array, stampedHtml: string }}
 */
function extractHtmlSections(html) {
  const $ = cheerio.load(html);
  const sections = [];
  let order = 0;

  // Stamp each candidate with a unique data attribute so the assembler can
  // reliably re-select it regardless of id/class volatility.
  const rawCandidates = $('section, .elementor-section, .e-con, .wp-block-group');
  
  // Filter out candidates that are inside another candidate (we only want top-level sections)
  let candidates = rawCandidates.filter(function() {
    return $(this).parents('section, .elementor-section, .e-con, .wp-block-group').length === 0;
  });

  // Elementor often uses a single or dual master wrapper (e.g. header + main body)
  // If we found very few top-level wrappers but they contain multiple inner sections, unpack them.
  if (candidates.length > 0 && candidates.length <= 2) {
    let unpacked = [];
    candidates.each((_, el) => {
      const inner = $(el).find('section, .elementor-section, .e-con, .wp-block-group').filter(function() {
        // exactly 1 level deep relative to the top
        return $(this).parents('section, .elementor-section, .e-con, .wp-block-group').length === 1;
      });
      if (inner.length >= 2) {
        inner.each((_, innerEl) => unpacked.push(innerEl));
      } else {
        unpacked.push(el);
      }
    });
    if (unpacked.length > candidates.length) {
      candidates = $(unpacked);
    }
  }

  if (candidates.length === 0) {
    // Fallback: treat the whole body as a single hero block
    return {
      sections: [{
        sectionId: 'body-wrapper',
        sectionType: 'hero',
        order: 0,
        required: true,
        visibilityRules: [],
        selector: 'body'
      }],
      stampedHtml: html
    };
  }

  candidates.each((i, el) => {
    // Assign a stable data attribute so we can re-select it precisely
    const uid = `ct-section-${i}`;
    $(el).attr('data-ct-uid', uid);

    const text = $(el).text();
    let type = classifySectionText(text);

    // H1 presence overrides keyword classification → always hero
    if ($(el).find('h1').length > 0) {
      type = 'hero';
    }

    // First section fallback to hero if still unknown
    if (i === 0 && type === 'unknown') {
      type = 'hero';
    }

    sections.push({
      sectionId: uid,
      sectionType: type,
      order: order++,
      required: ['hero', 'services', 'cta'].includes(type),
      visibilityRules: [],
      selector: `[data-ct-uid="${uid}"]`  // guaranteed unique & re-selectable
    });
  });

  // Return the Cheerio-serialised HTML — this now contains the data-ct-uid stamps
  return { sections, stampedHtml: $.html() };
}

/**
 * Main extraction entry point.
 * Returns both the templateConfig metadata AND the modified HTML that has
 * data-ct-uid attributes stamped onto each section so assembleHtml() can
 * reliably re-select them.
 *
 * @param {string} html
 * @param {string} elementorDataStr - Optional JSON string from WP meta `_elementor_data`
 * @returns {{ templateConfig: Object, stampedHtml: string }}
 */
export function extractTemplate(html, elementorDataStr = null) {
  const templateConfig = {
    templateId: 'tpl_' + Date.now(),
    builderType: 'standard_wp',
    sections: []
  };

  let stampedHtml = html; // default: return original if no stamping happened

  if (elementorDataStr) {
    try {
      const parsed = JSON.parse(elementorDataStr);
      templateConfig.builderType = 'elementor';
      templateConfig.sections = extractElementorSections(parsed);
      templateConfig.rawElementorData = parsed;
      // Elementor path doesn't stamp HTML — assembleElementor works on JSON
    } catch (e) {
      console.warn('[TemplateExtractor] Failed to parse Elementor data, falling back to HTML DOM', e);
      const result = extractHtmlSections(html);
      templateConfig.sections = result.sections;
      stampedHtml = result.stampedHtml;
    }
  } else {
    const result = extractHtmlSections(html);
    templateConfig.sections = result.sections;
    stampedHtml = result.stampedHtml;
  }

  return { templateConfig, stampedHtml };
}
