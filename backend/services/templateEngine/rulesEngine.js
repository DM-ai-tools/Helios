/**
 * Rules Engine for Template Sections
 * 
 * Determines which extracted template sections should be kept, removed, or
 * replaced based on the context of the sub-service being generated.
 */

const DEFAULT_REQUIRED_SECTIONS = ['hero', 'services', 'cta'];

/**
 * Evaluates the extracted sections against the requirements of the new sub-service.
 * 
 * @param {Object} templateConfig - The extracted template configuration
 * @param {Object} generationContext - Information about the sub-service being generated
 * @returns {Array} Updated section configuration with 'action' flags (keep, remove, insert)
 */
export function applySectionRules(templateConfig, generationContext) {
  const { subServiceName, industry, forcedSections = [], excludedSections = [] } = generationContext;
  const sections = [...templateConfig.sections];
  
  // 1. Process existing sections
  for (const section of sections) {
    // Default action is to keep
    section.action = 'keep';
    
    // Check if explicitly excluded
    if (excludedSections.includes(section.sectionType)) {
      section.action = 'remove';
      continue;
    }
    
    // Evaluate based on sub-service context
    // Example rule: Remove "comparison" for highly specific local services
    if (section.sectionType === 'comparison' && subServiceName.toLowerCase().includes('local')) {
      section.action = 'remove';
    }
    
    // Enforce default required sections
    if (DEFAULT_REQUIRED_SECTIONS.includes(section.sectionType)) {
      section.required = true;
    }
  }

  // 2. Insert new predefined components if required by context
  // e.g., if it's a Local SEO service and there's no map section
  if (subServiceName.toLowerCase().includes('local') && !sections.some(s => s.sectionType === 'local_map')) {
    // Find the best place to insert (usually after services or before process)
    let insertIndex = sections.findIndex(s => s.sectionType === 'services' || s.sectionType === 'process');
    if (insertIndex === -1) insertIndex = sections.length - 1;
    
    // We insert *after* the found section
    insertIndex++;

    sections.splice(insertIndex, 0, {
      sectionId: `inserted-local-map-${Date.now()}`,
      sectionType: 'local_map',
      order: insertIndex,
      required: true,
      action: 'insert',
      componentName: 'LocalMapComponent' // References a component in the Component Library
    });
    
    // Re-adjust ordering
    sections.forEach((s, idx) => s.order = idx);
  }

  return sections;
}

/**
 * Returns the final JSON schema requirements based on the filtered sections.
 * This ensures Claude ONLY generates content for sections that will actually be kept or inserted.
 */
export function generateRequiredJsonSchema(evaluatedSections) {
  const activeSections = evaluatedSections.filter(s => s.action === 'keep' || s.action === 'insert');
  
  // Always require SEO
  const requiredKeys = ['seo'];
  
  for (const section of activeSections) {
    // Map sectionType to JSON schema key
    let schemaKey = section.sectionType;
    if (schemaKey === 'trust_indicators') schemaKey = 'trustIndicators';
    if (schemaKey === 'pain_points') schemaKey = 'painPoints';
    if (schemaKey === 'case_studies') schemaKey = 'caseStudies';
    
    if (schemaKey !== 'unknown' && !requiredKeys.includes(schemaKey)) {
      requiredKeys.push(schemaKey);
    }
  }
  
  return requiredKeys;
}
