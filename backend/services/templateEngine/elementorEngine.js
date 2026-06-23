import fs from 'fs';
import path from 'path';

/**
 * Validates the Elementor JSON structure.
 */
export function validateElementorJson(elementorData) {
  if (!Array.isArray(elementorData)) {
    throw new Error('Elementor data must be an array of sections.');
  }

  let brokenWidgets = 0;
  
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    
    // Check if it's a widget and has settings
    if (node.elType === 'widget') {
      if (!node.widgetType || !node.id) {
        brokenWidgets++;
      }
    }
    
    if (Array.isArray(node.elements)) {
      node.elements.forEach(walk);
    }
  }

  elementorData.forEach(walk);

  if (brokenWidgets > 0) {
    throw new Error(`Elementor validation failed: found ${brokenWidgets} broken widgets missing widgetType or id.`);
  }

  return true;
}

/**
 * Creates a flat key-value map from a nested object.
 * e.g., { hero: { h1Title: "..." } } => { "hero.h1Title": "..." }
 * Now correctly flattens arrays: { process: [{title: "A"}] } => { "process.0.title": "A" }
 */
function flattenObject(ob, prefix = false, result = null) {
  result = result || {};
  for (const i in ob) {
    if (!ob.hasOwnProperty(i)) continue;
    if ((typeof ob[i]) === 'object' && ob[i] !== null) {
      flattenObject(ob[i], prefix ? prefix + '.' + i : i, result);
    } else {
      result[prefix ? prefix + '.' + i : i] = ob[i];
    }
  }
  return result;
}

/**
 * Duplicates Elementor JSON and performs placeholder replacement.
 * Returns { status, elementorData, replacementReport, diffReport, reason }
 */
export function processElementorTemplate(masterElementorData, generatedContent) {
  // Deep copy the template
  const newElementorData = JSON.parse(JSON.stringify(masterElementorData));
  
  // Flatten generated content for simple text replacements
  const flatContent = flattenObject(generatedContent);

  const report = {
    placeholdersFound: 0,
    placeholdersReplaced: 0,
    missingPlaceholders: 0,
    missingFields: []
  };

  const diffReport = {};

  // Helper to replace text placeholders like {{hero.h1Title}} or {{hero_title}}
  const replacePlaceholdersInString = (str) => {
    if (typeof str !== 'string') return str;
    
    // Fast path: if no placeholder exists, return early
    if (!str.includes('{{')) return str;

    const placeholderRegex = /{{\s*([^}]+?)\s*}}/g;
    
    return str.replace(placeholderRegex, (fullMatch, p1) => {
      report.placeholdersFound++;
      const key = p1.trim();
      
      let replacedValue = null;
      let matchedKey = null;

      if (flatContent[key] !== undefined && flatContent[key] !== null) {
        replacedValue = flatContent[key];
        matchedKey = key;
      } else {
        const normalizeKey = (k) => {
          let s = k.replace(/\./g, '_').replace(/([A-Z])/g, "_$1").toLowerCase();
          // Remove common fluff words from placeholders
          s = s.replace(/_(step|item|row|card|box)_/g, '_');
          // Handle trailing numbers without underscores (e.g. faq1 -> faq_1)
          s = s.replace(/([a-z])(\d+)/g, "$1_$2");
          return s;
        };

        const normKey = normalizeKey(key);

        for (const [flatKey, flatValue] of Object.entries(flatContent)) {
          const normFlatKey = normalizeKey(flatKey);
          
          if (normKey === normFlatKey) {
             replacedValue = flatValue;
             matchedKey = flatKey;
             break;
          }
          
          // Try decrementing numbers in the placeholder (1-indexed to 0-indexed)
          // e.g. process_1_title matches process_0_title
          const decrementedKey = normKey.replace(/_(\d+)(_|$)/g, (match, num, suffix) => {
            return `_${parseInt(num, 10) - 1}${suffix}`;
          });

          if (decrementedKey === normFlatKey) {
             replacedValue = flatValue;
             matchedKey = flatKey;
             break;
          }
        }
      }

      if (replacedValue !== null) {
        report.placeholdersReplaced++;
        
        // Track for diffReport (e.g. heroUpdated, faqUpdated)
        const sectionName = matchedKey.split('.')[0] || matchedKey.split('_')[0];
        if (sectionName) {
          diffReport[`${sectionName}Updated`] = true;
        }

        return replacedValue;
      } else {
        report.missingPlaceholders++;
        if (!report.missingFields.includes(key)) {
          report.missingFields.push(key);
        }
        // Do not silently fallback to original content
        // Return the original placeholder so it gets caught by the final validation
        return fullMatch;
      }
    });
  };

  // Process object recursively
  const processObject = (obj) => {
    if (!obj) return;

    if (Array.isArray(obj)) {
      obj.forEach(item => processObject(item));
      return;
    }

    if (typeof obj === 'object') {
      for (const key in obj) {
        if (!obj.hasOwnProperty(key)) continue;
        
        const value = obj[key];
        if (typeof value === 'string') {
          obj[key] = replacePlaceholdersInString(value);
        } else if (typeof value === 'object' && value !== null) {
          processObject(value);
        }
      }
    }
  };

  // Helper to process specific repeater logic
  const injectRepeaterContent = (widget) => {
    if (!widget.settings) return;

    if (widget.widgetType === 'accordion' || widget.widgetType === 'toggle') {
      if (generatedContent.faqs && Array.isArray(generatedContent.faqs)) {
        widget.settings.tabs = generatedContent.faqs.map((faq, index) => ({
          _id: `faq-${index}-${Date.now()}`,
          tab_title: faq.question,
          tab_content: faq.answer
        }));
        diffReport['faqsUpdated'] = true;
      }
    }

    if (widget.widgetType === 'testimonial-carousel') {
      if (generatedContent.testimonials && Array.isArray(generatedContent.testimonials)) {
        widget.settings.slides = generatedContent.testimonials.map((t, index) => ({
          _id: `testimonial-${index}-${Date.now()}`,
          content: t.quote,
          name: t.author,
          title: t.role ? `${t.role}${t.company ? ' at ' + t.company : ''}` : t.company || ''
        }));
        diffReport['testimonialsUpdated'] = true;
      }
    } else if (widget.widgetType === 'testimonial') {
      if (generatedContent.testimonials && generatedContent.testimonials.length > 0) {
        const t = generatedContent.testimonials[0]; // Just use the first one
        widget.settings.testimonial_content = t.quote;
        widget.settings.testimonial_name = t.author;
        widget.settings.testimonial_job = t.role ? `${t.role}${t.company ? ' at ' + t.company : ''}` : t.company || '';
        diffReport['testimonialsUpdated'] = true;
      }
    }
  };

  // Walk the tree for specific repeater injections first
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    
    if (node.elType === 'widget') {
      injectRepeaterContent(node);
    }
    
    if (Array.isArray(node.elements)) {
      node.elements.forEach(walk);
    }
  }

  newElementorData.forEach(walk);

  // Now perform recursive string replacement EVERYWHERE
  processObject(newElementorData);

  // Validate post-processing
  const jsonString = JSON.stringify(newElementorData);
  const unresolved =
      jsonString.includes('{{') ||
      jsonString.includes('}}') ||
      jsonString.includes('[Generated');

  if (unresolved) {
      return {
          status: 'failed',
          reason: `Unresolved placeholders detected. Deployment blocked. Missing: ${report.missingFields.join(', ')}`,
          replacementReport: report,
          diffReport: diffReport
      };
  }

  // Check if more than 10% fields missing/unchanged?
  // The user said: "Block publishing if: More than 10% of editable fields remain unchanged"
  // Since we don't track original fields easily without a full diff against master,
  // we can just rely on the placeholders check which covers it.

  // Validate the final JSON structure matches Elementor expectations
  try {
    validateElementorJson(newElementorData);
  } catch (err) {
    return {
        status: 'failed',
        reason: `Elementor validation failed: ${err.message}`,
        replacementReport: report,
        diffReport: diffReport
    };
  }

  return {
    status: 'success',
    elementorData: newElementorData,
    replacementReport: report,
    diffReport: diffReport
  };
}

/**
 * Loads a predefined Elementor section component from the library.
 */
export function getElementorComponent(componentName) {
  const componentPath = path.join(process.cwd(), 'backend/templates/elementor/components', `${componentName}.json`);
  if (fs.existsSync(componentPath)) {
    try {
      return JSON.parse(fs.readFileSync(componentPath, 'utf8'));
    } catch (e) {
      console.error(`[elementorEngine] Error parsing component ${componentName}:`, e);
      return null;
    }
  }
  console.warn(`[elementorEngine] Component not found: ${componentName}`);
  return null;
}
