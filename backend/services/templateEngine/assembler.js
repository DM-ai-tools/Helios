import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

/**
 * Maps AI generated JSON into a raw HTML DOM tree using Cheerio semantically.
 */
export function assembleHtml(rawHtml, evaluatedSections, generatedContent, generationId, tracer) {
  const $ = cheerio.load(rawHtml);
  
  if (generatedContent.seo) {
    $('title').text(generatedContent.seo.pageTitle || '');
    const metaDesc = $('meta[name="description"]');
    if (metaDesc.length) {
      metaDesc.attr('content', generatedContent.seo.metaDescription || '');
    } else {
      $('head').append(`<meta name="description" content="${(generatedContent.seo.metaDescription || '').replace(/"/g, '&quot;') }">`);
    }
  }

  const sortedSections = [...evaluatedSections].sort((a, b) => b.order - a.order);

  for (const section of sortedSections) {
    const $section = $(section.selector);
    
    if (!$section.length && section.action !== 'insert') continue;

    if (section.action === 'remove') {
      $section.remove();
      continue;
    }

    if (section.action === 'keep') {
      const sectionKey = getJsonMappingKey(section.sectionType);
      const content = generatedContent[sectionKey];
      if (content) {
        // TRACE POINT 10: Content Merge Priority (Implicit in the DOM text update)
        // We log the mapping here to satisfy TRACE POINT 6
        if (tracer && typeof content === 'object') {
          Object.keys(content).forEach(k => {
            if (typeof content[k] === 'string') {
               tracer.logTemplateMapping(generationId, `DOM:${sectionKey}.${k}`, content[k], content[k]); // Assuming text is replaced
            }
          });
        }
        injectContentIntoCheerioNode($, $section, content, section.sectionType);
      }
    }
    
    if (section.action === 'insert') {
      const componentPath = path.join(process.cwd(), 'backend/templates/components', `${section.sectionType}.html`);
      if (fs.existsSync(componentPath)) {
        let componentHtml = fs.readFileSync(componentPath, 'utf8');
        // Simple template replacement for inserted components
        const sectionKey = getJsonMappingKey(section.sectionType);
        const content = generatedContent[sectionKey];
        if (content) {
          Object.keys(content).forEach(k => {
            if (typeof content[k] === 'string') {
              const regex = new RegExp(`{{${k}}}`, 'g');
              const matchCount = (componentHtml.match(regex) || []).length;
              if (matchCount > 0 && tracer) {
                // TRACE POINT 6: Log Template Mapping
                tracer.logTemplateMapping(generationId, `{{${k}}}`, content[k], content[k]);
              }
              componentHtml = componentHtml.replace(regex, content[k]);
            }
          });
        }
        
        // Find where to insert
        const previousSection = sortedSections.find(s => s.order === section.order - 1);
        if (previousSection && $(previousSection.selector).length) {
          $(previousSection.selector).after(componentHtml);
        } else {
          $('main').append(componentHtml);
        }
      } else {
        console.warn(`[Assembler] Component template not found for ${section.sectionType}`);
      }
    }
  }

  return $.html();
}

function findRepeatingContainers($, $context) {
  let bestChildren = [];
  let bestScore = 0;

  // Try multiple nesting levels so Elementor's extra wrapper divs are not skipped
  const searchTargets = [
    $context,
    ...$context.find('div, ul, section, .e-con, table, tbody').toArray().map(el => $(el))
  ];

  for (const $el of searchTargets) {
    const children = $el.children().toArray().map(c => $(c));
    if (children.length >= 2) {
      const tagElements = {};
      children.forEach($c => {
        const tag = $c.prop('tagName');
        // Ignore non-structural/non-visual tags
        if (['STYLE', 'SCRIPT', 'NOSCRIPT', 'LINK', 'META', 'BR', 'HR'].includes(tag)) return;
        
        // Group elements by tag
        if (!tagElements[tag]) tagElements[tag] = [];
        tagElements[tag].push($c);
      });

      for (const [tag, elements] of Object.entries(tagElements)) {
        // We only consider it repeating if there's at least 2, OR if it's a known repeater item type (like a single FAQ or a single TR)
        if (elements.length >= 2) {
          // Calculate a "score" for these elements to avoid picking 5 small icons over 3 big cards
          // A good card should have headings or paragraphs or significant text
          let score = elements.length;
          let hasSignificantContent = false;
          
          for (const $child of elements) {
            if ($child.find('h2, h3, h4, h5, h6, p, .elementor-heading-title, .elementor-text-editor, .elementor-widget-icon-box').length > 0) {
              hasSignificantContent = true;
              score += 10; // Boost score if it contains typical card content
            }
          }
          
          if (hasSignificantContent && score > bestScore) {
            bestScore = score;
            // Create a Cheerio object from the array of Cheerio nodes
            bestChildren = $(elements.map(e => e[0]));
          }
        } else if (elements.length === 1) {
          const singleEl = elements[0];
          const classList = singleEl.attr('class') || '';
          const isKnownRepeaterItem = 
            classList.includes('elementor-repeater-item') ||
            classList.includes('elementor-accordion-item') ||
            classList.includes('elementor-toggle-item') ||
            classList.includes('elementor-icon-list-item') ||
            classList.includes('elementor-price-table') ||
            tag === 'TR';

          if (isKnownRepeaterItem) {
            let score = 5;
            if (singleEl.find('h2, h3, h4, h5, h6, p, .elementor-heading-title, .elementor-text-editor, .elementor-widget-icon-box').length > 0) {
              score += 10;
            }
            if (score > bestScore) {
              bestScore = score;
              bestChildren = $([singleEl[0]]);
            }
          }
        }
      }
    }
  }

  return bestChildren.length > 0 ? bestChildren : null;
}

function syncCheerioRepeatingElements($, $parent, children, targetCount) {
  let childElements = children.toArray();
  if (childElements.length === 0) return [];
  const template = $(childElements[0]).clone();
  
  while (childElements.length > targetCount) {
    $(childElements[childElements.length - 1]).remove();
    childElements.pop();
  }
  
  while (childElements.length < targetCount) {
    const newEl = template.clone();
    $(childElements[childElements.length - 1]).after(newEl);
    childElements.push(newEl[0]);
  }
  
  return childElements.map(el => $(el));
}

function injectContentIntoCheerioNode($, $section, contentObj, sectionType) {
  // Broad heading/paragraph selectors to cover both vanilla HTML and Elementor markup
  const HEADING_SEL = 'h1, h2, h3, h4, .elementor-heading-title';
  const PARA_SEL    = 'p, .elementor-text-editor';

  const updateHeadings = (obj) => {
    const h1     = obj.h1Title    ?? obj.headline   ?? null;
    const h2     = obj.h2Title    ?? obj.title       ?? null;
    const sub    = obj.subheading ?? obj.intro       ?? obj.description ?? null;
    const eyebrow = obj.eyebrow   ?? null;

    // Use != null so even an empty string from Claude replaces the original text
    if (h1 != null)     $section.find('h1').first().text(h1);
    if (h2 != null)     $section.find('h2, h3, .elementor-heading-title').not('h1').first().text(h2);
    if (eyebrow != null) {
      const $eyebrow = $section.find('.eyebrow, .label, .badge, .tag, small').first();
      if ($eyebrow.length) $eyebrow.text(eyebrow);
    }
    if (sub != null) {
      const $paras = $section.find(PARA_SEL).filter(function () {
        return $(this).closest('h1, h2, h3, h4, h5, .elementor-heading-title').length === 0;
      });
      if ($paras.length) $paras.first().text(sub);
    }
  };

  // 1. Array Data Mapping (Cards, Grids, Lists)
  if (Array.isArray(contentObj)) {
    const childrenNodes = findRepeatingContainers($, $section);
    if (childrenNodes) {
      const itemElements = syncCheerioRepeatingElements($, childrenNodes.parent(), childrenNodes, contentObj.length);
      itemElements.forEach(($item, idx) => {
        const data = contentObj[idx];
        if (!data) return;
        const title = data.title ?? data.scenarioTitle ?? data.feature ?? data.question ?? data.quote ?? null;
        const desc  = data.description ?? data.answer ?? data.author ?? data.traditional ?? data.ai ?? null;

        if (title != null) $item.find('h3, h4, h5, strong, .elementor-heading-title').first().text(title);
        if (desc != null) {
          const $pTags = $item.find(PARA_SEL).filter(function () {
            return $(this).find('strong, h3, h4, h5').length === 0;
          });
          if ($pTags.length > 0) {
            $($pTags[0]).text(desc);
            for (let i = 1; i < $pTags.length; i++) {
              $($pTags[i]).remove();
            }
          } else {
            $item.append(`<p>${desc}</p>`);
          }
        }
      });
    }
    return;
  }


  // 2. Object Data Mapping (Hero, Problem, CTA …)
  updateHeadings(contentObj);

  // Handle nested arrays inside an object (e.g. trustBadges inside hero, metrics inside caseStudy)
  Object.keys(contentObj).forEach(key => {
    const val = contentObj[key];
    if (!Array.isArray(val) || val.length === 0) return;

    // Limit scope to a sub-container that looks like a badge/metric row
    const subChildrenNodes = findRepeatingContainers($, $section);
    if (subChildrenNodes) {
      const itemElements = syncCheerioRepeatingElements($, subChildrenNodes.parent(), subChildrenNodes, val.length);
      itemElements.forEach(($item, idx) => {
        const data = val[idx];
        if (!data) return;
        const itemVal   = data.value || data.title || (typeof data === 'string' ? data : '');
        const itemLabel = data.label || data.description || '';
        if (itemVal)   $item.find('h3, h4, strong, span').first().text(itemVal);
        if (itemLabel) $item.find('p, span').last().text(itemLabel);
      });
    }
  });
}

/**
 * Maps the AI-generated JSON content back into the extracted Elementor data tree semantically.
 */
export function assembleElementor(rawElementorData, evaluatedSections, generatedContent) {
  const newElementorData = JSON.parse(JSON.stringify(rawElementorData));
  
  function processNode(node, parentArray, indexInParent) {
    if (node.elType === 'section') {
      const sectionConfig = evaluatedSections.find(s => s.sectionId === node.id);
      if (sectionConfig) {
        if (sectionConfig.action === 'remove') return false; 
        if (sectionConfig.action === 'keep') {
          const sectionKey = getJsonMappingKey(sectionConfig.sectionType);
          const contentForSection = generatedContent[sectionKey];
          if (contentForSection) {
            injectContentIntoElementorTree(node, contentForSection, sectionConfig.sectionType);
          }
        }
      }
    }
    if (node.elements && Array.isArray(node.elements)) {
      node.elements = node.elements.filter((child, idx) => processNode(child, node.elements, idx));
    }
    return true;
  }

  const finalData = newElementorData.filter((node, idx) => processNode(node, newElementorData, idx));
  
  // Handle insert actions by finding where to inject raw Elementor blocks
  // For simplicity, we skip inserting Elementor blocks for dynamically added sections
  // unless we pre-author Elementor JSON files for components, which is complex.
  
  return finalData;
}

function injectContentIntoElementorTree(sectionNode, contentObj, sectionType) {
  let isArray = Array.isArray(contentObj);
  let arrayQueue = isArray ? [...contentObj] : [];
  
  // We extract headings and paragraphs from the object
  let headings = [];
  let paragraphs = [];
  
  if (!isArray) {
    if (contentObj.h1Title || contentObj.headline) headings.push(contentObj.h1Title || contentObj.headline);
    if (contentObj.h2Title || contentObj.title || contentObj.eyebrow) headings.push(contentObj.h2Title || contentObj.title || contentObj.eyebrow);
    if (contentObj.subheading || contentObj.intro || contentObj.description) paragraphs.push(contentObj.subheading || contentObj.intro || contentObj.description);
  }

  // Walk Elementor tree
  function walkAndMap(node) {
    if (node.widgetType === 'heading') {
      if (!isArray && headings.length > 0) {
        node.settings.title = headings.shift();
      } else if (isArray && arrayQueue.length > 0) {
        // If it's a list, headings usually map to titles in items
        // Wait, Elementor arrays are usually columns holding icon-boxes.
        // We handle standard widgets.
      }
    } else if (node.widgetType === 'text-editor') {
      if (!isArray && paragraphs.length > 0) {
        node.settings.editor = `<p>${paragraphs.shift()}</p>`;
      }
    } else if (node.widgetType === 'icon-box' || node.widgetType === 'image-box') {
      if (isArray && arrayQueue.length > 0) {
        const item = arrayQueue.shift();
        node.settings.title_text = item.title || item.scenarioTitle || item.feature || item.question || item.value || '';
        node.settings.description_text = item.description || item.answer || item.label || '';
      }
    }
    
    if (node.elements) {
      // Basic repeating elements cloner for Elementor
      if (isArray && node.elType === 'column' && node.elements.some(e => e.widgetType === 'icon-box')) {
        // We could clone columns here if needed
      }
      node.elements.forEach(walkAndMap);
    }
  }
  
  walkAndMap(sectionNode);
}

function getJsonMappingKey(sectionType) {
  const map = {
    trust_indicators: 'trustIndicators',
    pain_points: 'painPoints',
    case_studies: 'caseStudies',
    comparison: 'comparisonTable',        // legacy extractor type name
    comparisonTable: 'comparisonTable',
    faq: 'faqs',                           // legacy extractor type name
    faqs: 'faqs',
    problem: 'problemSection',             // legacy extractor type name
    problemSection: 'problemSection',
    local_map: 'local_map',
  };
  return map[sectionType] || sectionType;
}
