import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where this server is written for UIC GPT: `%APPDATA%\UIC GPT\uic_gpt_config.json`.
 *
 * UIC GPT reads that file in exactly Claude Desktop's `{ mcpServers }` shape,
 * picks changes up by itself, and registers and allows the tools of any server
 * it finds there — so setup merges into it with the same pure function as the
 * Claude side (configMerge.mjs) and needs nothing UIC-specific beyond the path.
 *
 * The older `%LOCALAPPDATA%\UICGPTAgent\agent.config.json`, with its
 * connectorId and hand-kept allowedTools, is deliberately NOT written: an entry
 * there with an empty allowlist looks configured and refuses every job.
 */

/**
 * `%APPDATA%\UIC GPT\uic_gpt_config.json`. APPDATA is read rather than rebuilt,
 * because it moves on roaming and domain-joined profiles.
 */
export function uicConfigPath(env = process.env) {
  const base = env.APPDATA;
  if (base && base.trim().length > 0) return join(base, 'UIC GPT', 'uic_gpt_config.json');
  return null;
}

/** Is UIC GPT on this machine? Advisory only: labels the menu, never blocks. */
export function isUicInstalled(env = process.env) {
  const configPath = uicConfigPath(env);
  if (configPath && existsSync(configPath)) return true;
  if (env.APPDATA && existsSync(join(env.APPDATA, '@uic'))) return true;
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES;
  return programFiles ? existsSync(join(programFiles, 'UIC GPT')) : false;
}
