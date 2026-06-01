// ============================================================
// backend/services/pluginLoader.js
// Dynamic plugin loader — loads plugin files by ID
// Falls back to ALL plugins when selectedPlugins is empty
// ============================================================

import { pathToFileURL } from 'url';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Registry of all available plugin IDs
export const ALL_PLUGIN_IDS = [
  'seo-audit',
  'competitive-brief',
  'campaign-plan',
  'content-copy',
  'email-sequence',
  'brand-review',
];

/**
 * Load a single plugin module by ID.
 * @param {string} pluginId - e.g. 'seo-audit'
 * @returns {Promise<Object>} Plugin config object
 */
export async function loadPlugin(pluginId) {
  if (!ALL_PLUGIN_IDS.includes(pluginId)) {
    throw new Error(`Unknown plugin ID: "${pluginId}". Valid IDs: ${ALL_PLUGIN_IDS.join(', ')}`);
  }

  const pluginPath = resolve(__dirname, `../plugins/${pluginId}.js`);
  const pluginUrl = pathToFileURL(pluginPath).href;

  const module = await import(pluginUrl);
  const plugin = module.default;

  // Validate plugin shape
  const required = ['id', 'name', 'systemPrompt', 'scoringPrompt', 'outputFormat', 'buildUserPrompt'];
  for (const field of required) {
    if (!plugin[field]) {
      throw new Error(`Plugin "${pluginId}" is missing required field: "${field}"`);
    }
  }

  return plugin;
}

/**
 * Load multiple plugins dynamically.
 * If selectedPluginIds is empty, loads ALL plugins.
 *
 * @param {string[]} selectedPluginIds - Array of plugin IDs from frontend
 * @returns {Promise<Object[]>} Array of loaded plugin configs
 */
export async function loadPlugins(selectedPluginIds = []) {
  const idsToLoad = selectedPluginIds.length > 0
    ? selectedPluginIds
    : ALL_PLUGIN_IDS;

  console.log(`[PluginLoader] Loading ${idsToLoad.length} plugins: ${idsToLoad.join(', ')}`);

  const plugins = await Promise.all(
    idsToLoad.map(async (id) => {
      try {
        const plugin = await loadPlugin(id);
        console.log(`[PluginLoader] ✓ Loaded plugin: ${plugin.name}`);
        return plugin;
      } catch (err) {
        console.error(`[PluginLoader] ✗ Failed to load plugin "${id}": ${err.message}`);
        return null;
      }
    })
  );

  // Filter out failed loads
  return plugins.filter(Boolean);
}

/**
 * Get plugin metadata (without loading full module).
 * Used for API responses and processing page display.
 */
export function getPluginMetadata(pluginIds = []) {
  const ids = pluginIds.length > 0 ? pluginIds : ALL_PLUGIN_IDS;
  return ids.filter(id => ALL_PLUGIN_IDS.includes(id)).map(id => ({ id }));
}
