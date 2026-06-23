import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

/**
 * Tracer Module for tracking end-to-end page generation
 */
class PageGenerationTracer {
  constructor() {
    this.traces = new Map(); // Store in-memory traces during generation
    this.logDir = path.join(process.cwd(), 'backend', 'logs');
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  getTrace(generationId) {
    if (!this.traces.has(generationId)) {
      this.traces.set(generationId, {
        generationId,
        timestamps: {},
        inputData: null,
        claudeRequest: null,
        claudeResponse: null,
        similarityScore: null,
        dbStorage: { before: null, after: null },
        cacheInspection: [],
        templateMapping: [],
        placeholders: { total: 0, replaced: 0, unreplaced: 0, list: [] },
        htmlVerification: null,
        flags: [],
        rootCause: null
      });
    }
    return this.traces.get(generationId);
  }

  logInputData(generationId, data) {
    const trace = this.getTrace(generationId);
    trace.timestamps.inputData = Date.now();
    trace.inputData = data;
    
    console.log(`[TRACE ${generationId}] POINT 1: Input Data Loaded`);
    
    // Verify requested sub-service differs from source service
    if (data.subServiceName && data.serviceName && data.subServiceName.toLowerCase() === data.serviceName.toLowerCase()) {
      trace.flags.push('Sub-service matches parent service. Generation may be identical to source.');
    }
  }

  logClaudeRequest(generationId, payload) {
    const trace = this.getTrace(generationId);
    trace.timestamps.claudeRequest = Date.now();
    trace.claudeRequest = payload;
    
    console.log(`[TRACE ${generationId}] POINT 2: Claude Request Dispatched`);

    // Verify full source HTML is NOT included
    const payloadStr = JSON.stringify(payload);
    if (payloadStr.includes('<html') || payloadStr.includes('<!DOCTYPE html>')) {
      trace.flags.push('Claude request contains raw HTML payload! Should only be editable JSON requirements.');
    }
  }

  logClaudeResponse(generationId, rawResponse, extractedJson, sourceContentStr) {
    const trace = this.getTrace(generationId);
    trace.timestamps.claudeResponse = Date.now();
    trace.claudeResponse = { raw: rawResponse, extractedJson };
    
    console.log(`[TRACE ${generationId}] POINT 3: Claude Response Received`);

    // Calculate similarity score
    const generatedContentStr = JSON.stringify(extractedJson);
    const score = this.calculateSimilarityScore(sourceContentStr, generatedContentStr);
    trace.similarityScore = score;
    
    if (score > 0.70) {
      trace.flags.push(`High similarity detected (${(score * 100).toFixed(2)}%). Generation failed to significantly alter source content.`);
    }

    // Dump raw response
    const dumpPath = path.join(this.logDir, `trace_${generationId}_claude.json`);
    fs.writeFileSync(dumpPath, JSON.stringify({ generationId, claudeOutput: extractedJson }, null, 2));
  }

  calculateSimilarityScore(sourceStr, genStr) {
    if (!sourceStr || !genStr) return 0;
    const cleanSource = sourceStr.replace(/[^a-zA-Z0-9]/g, ' ').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const cleanGen = genStr.replace(/[^a-zA-Z0-9]/g, ' ').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    
    const sourceSet = new Set(cleanSource);
    const genSet = new Set(cleanGen);
    
    let intersection = 0;
    for (const word of genSet) {
      if (sourceSet.has(word)) intersection++;
    }
    
    const union = new Set([...sourceSet, ...genSet]).size;
    return union === 0 ? 0 : intersection / union;
  }

  logDbStorage(generationId, jsonBefore, jsonAfter) {
    const trace = this.getTrace(generationId);
    trace.timestamps.dbStorage = Date.now();
    trace.dbStorage = { before: jsonBefore, after: jsonAfter };
    
    console.log(`[TRACE ${generationId}] POINT 4: Database Storage Verified`);

    if (JSON.stringify(jsonBefore) !== JSON.stringify(jsonAfter)) {
      trace.flags.push('Database retrieved JSON does not match pre-save JSON.');
    }
  }

  inspectCache(generationId, keys, statuses) {
    const trace = this.getTrace(generationId);
    trace.cacheInspection.push({ keys, statuses, timestamp: Date.now() });
    console.log(`[TRACE ${generationId}] POINT 5: Cache Inspected - ${keys.join(', ')}`);
  }

  logTemplateMapping(generationId, placeholder, generatedValue, mappedValue) {
    const trace = this.getTrace(generationId);
    trace.templateMapping.push({ placeholder, generatedValue, mappedValue });
    if (generatedValue !== mappedValue) {
      trace.flags.push(`Mapping mismatch for ${placeholder}: Expected "${generatedValue}", Got "${mappedValue}"`);
    }
  }

  validatePlaceholders(generationId, html) {
    const trace = this.getTrace(generationId);
    trace.timestamps.validation = Date.now();
    
    console.log(`[TRACE ${generationId}] POINT 7: Placeholder Validation`);
    
    if (!html) {
      trace.placeholders.unreplaced = 0;
      trace.placeholders.list = [];
      return;
    }
    
    // Look for unreplaced {{something}} placeholders
    const matches = html.match(/\{\{([^}]+)\}\}/g) || [];
    trace.placeholders.unreplaced = matches.length;
    trace.placeholders.list = matches;
    
    if (matches.length > 0) {
      trace.flags.push(`Found ${matches.length} unreplaced placeholders in final HTML.`);
    }
  }

  verifyRenderedHtml(generationId, finalHtml, oldName, newName) {
    const trace = this.getTrace(generationId);
    trace.timestamps.htmlVerification = Date.now();
    trace.htmlVerification = { oldName, newName, oldOccurrences: 0, newOccurrences: 0 };
    
    console.log(`[TRACE ${generationId}] POINT 8: Rendered HTML Inspected`);
    
    if (!finalHtml) {
      trace.flags.push(`No final HTML generated (Elementor mode).`);
      return;
    }
    
    const oldRegex = new RegExp(oldName, 'gi');
    const newRegex = new RegExp(newName, 'gi');
    
    trace.htmlVerification.oldOccurrences = (finalHtml.match(oldRegex) || []).length;
    trace.htmlVerification.newOccurrences = (finalHtml.match(newRegex) || []).length;

    if (trace.htmlVerification.newOccurrences === 0) {
      trace.flags.push(`Target sub-service name "${newName}" not found in rendered HTML.`);
    }
    
    const dumpPath = path.join(this.logDir, `trace_${generationId}_final.html`);
    fs.writeFileSync(dumpPath, finalHtml);
  }

  generateRootCauseAnalysis(generationId) {
    const trace = this.getTrace(generationId);
    console.log(`[TRACE ${generationId}] POINT 12: Generating Root Cause Analysis`);
    
    let rootCause = "SUCCESS: Generation passed all trace points.";
    let stage = "N/A";
    let expected = "N/A";
    let actual = "N/A";
    let recommendation = "None";

    if (trace.flags.length > 0) {
      // Analyze flags to determine earliest point of failure
      if (trace.flags.some(f => f.includes('Sub-service matches parent service'))) {
        stage = "INPUT_VALIDATION";
        rootCause = "Requested sub-service is identical to parent service.";
        expected = "Differing service names.";
        actual = "Same service names.";
        recommendation = "Ensure UI provides unique sub-service name.";
      } else if (trace.flags.some(f => f.includes('raw HTML payload'))) {
        stage = "CLAUDE_PROMPT";
        rootCause = "Claude was fed full raw HTML instead of specific requirements.";
        expected = "JSON requirement keys.";
        actual = "Raw HTML payload.";
        recommendation = "Filter HTML out of system prompt in pageWorker.js.";
      } else if (trace.flags.some(f => f.includes('High similarity detected'))) {
        stage = "CLAUDE_GENERATION";
        rootCause = "Claude output is too similar to source content.";
        expected = "Significantly altered content.";
        actual = `Similarity > 70%`;
        recommendation = "Increase temperature or inject stronger negative prompts against source cloning.";
      } else if (trace.flags.some(f => f.includes('Mapping mismatch'))) {
        stage = "TEMPLATE_MAPPING";
        rootCause = "Generated JSON values failed to map onto Cheerio/DOM nodes correctly.";
        expected = "DOM text replaced.";
        actual = "DOM text retained original values.";
        recommendation = "Check assembler.js mapping keys (getJsonMappingKey) and CSS selectors.";
      } else if (trace.flags.some(f => f.includes('unreplaced placeholders'))) {
        stage = "ASSEMBLY";
        rootCause = "Hardcoded template strings {{}} were not substituted.";
        expected = "Clean HTML without {{}} tags.";
        actual = `Found ${trace.placeholders.unreplaced} unreplaced tags.`;
        recommendation = "Ensure generated JSON contains keys for all template substitutions.";
      } else if (trace.flags.some(f => f.includes('Target sub-service name'))) {
        stage = "FINAL_HTML_VERIFICATION";
        rootCause = "Sub-service name completely missing from final DOM output.";
        expected = `Occurrences of new service > 0`;
        actual = "0 Occurrences.";
        recommendation = "Assembler likely failed to identify target .e-con sections on the live page.";
      } else {
        stage = "UNKNOWN";
        rootCause = trace.flags[0];
      }
    }

    trace.rootCause = { stage, expected, actual, rootCause, recommendation };

    const reportPath = path.join(this.logDir, `rca_${generationId}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(trace, null, 2));
    
    console.log(`[RCA REPORT FOR ${generationId}]\nStage: ${stage}\nCause: ${rootCause}\nRecommendation: ${recommendation}\nSaved to: ${reportPath}`);
    return trace.rootCause;
  }
}

export const tracer = new PageGenerationTracer();
