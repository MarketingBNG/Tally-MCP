/**
 * Merging this server into an existing claude_desktop_config.json.
 *
 * Split out as a pure function, with no filesystem access, because this is the
 * one piece of setup that can destroy something the user cares about: their
 * other configured MCP servers. It is unit-tested for that reason. Everything
 * around it (finding the file, backups, printing advice) is recoverable; losing
 * a Gmail or Drive connector someone else set up is not.
 *
 * Plain ESM with no dependencies on purpose — this runs from the bundled Node
 * runtime inside the shipped folder, where there is no node_modules.
 */

/** The key this server occupies in `mcpServers`. Also the name Claude shows. */
export const SERVER_KEY = 'tally';

/**
 * Returns a new config object with this server registered, preserving
 * everything else the file contained.
 *
 * @param {unknown} existing Parsed contents of claude_desktop_config.json, or
 *   null/undefined when the file does not exist yet.
 * @param {{ nodePath: string, serverPath: string, env: Record<string,string> }} entry
 * @returns {{ config: object, replacedExisting: boolean, preservedServers: string[] }}
 */
export function mergeServerIntoConfig(existing, entry) {
  // Anything that is not a plain object is not a config we can safely extend.
  // Treating it as empty here would silently discard the user's file, so the
  // caller is expected to have already refused in that case — this is a guard,
  // not a recovery path.
  const base = isPlainObject(existing) ? { ...existing } : {};

  const servers = isPlainObject(base.mcpServers) ? { ...base.mcpServers } : {};

  const replacedExisting = Object.prototype.hasOwnProperty.call(servers, SERVER_KEY);
  const preservedServers = Object.keys(servers).filter((name) => name !== SERVER_KEY);

  servers[SERVER_KEY] = {
    command: entry.nodePath,
    args: [entry.serverPath],
    env: { ...entry.env },
  };

  base.mcpServers = servers;

  return { config: base, replacedExisting, preservedServers };
}

/**
 * True only for `{...}` — not arrays, not null. Arrays are objects in JS and
 * `{...[]}` yields `{}`, which would quietly erase a malformed config.
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
