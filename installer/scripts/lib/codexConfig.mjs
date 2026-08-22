import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { claudeConfigCandidates } from './paths.mjs';

/**
 * Writing this server into Codex's `~/.codex/config.toml`.
 *
 * The Claude side of setup edits `claude_desktop_config.json` directly rather
 * than shelling out to anything, and this deliberately mirrors that: the file
 * is merged in-process, from a pure function, with a backup taken first. The
 * alternative — invoking `codex mcp add` — was rejected for two reasons found
 * on a real machine:
 *
 * - `codex` is frequently NOT on PATH. The desktop build installs to
 *   `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`, where the hash changes
 *   between versions, so locating it is guesswork that fails silently.
 * - Shelling out cannot be unit-tested without Codex installed, and the whole
 *   point of a pure merge is that the case which must never happen — clobbering
 *   somebody's other MCP servers — is covered by a test.
 *
 * The shape written is taken from a real Codex config (CLI 0.147.0), which
 * carries its own `node_repl` server in exactly this form:
 *
 *     [mcp_servers.tally]
 *     command = 'C:\path\to\node.exe'
 *     args = ['C:\path\to\dist\index.js']
 *
 *     [mcp_servers.tally.env]
 *     TALLY_PORT = "9000"
 */

/** The server key written into config.toml. */
export const CODEX_SERVER_KEY = 'tally';

/**
 * Quote a value for TOML.
 *
 * Single quotes make a LITERAL string, in which a backslash is just a
 * backslash — which is what a Windows path is made of. Codex's own config uses
 * literal strings for its paths for the same reason. A path containing a single
 * quote cannot be expressed that way at all, so those fall back to a basic
 * string with the backslashes escaped.
 */
export function tomlString(value) {
  const text = String(value);
  if (!text.includes("'")) return `'${text}'`;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Render the `[mcp_servers.<name>]` block, env table included. */
export function renderServerBlock({ serverName = CODEX_SERVER_KEY, nodePath, serverPath, env = {} }) {
  const out = [
    `[mcp_servers.${serverName}]`,
    `command = ${tomlString(nodePath)}`,
    `args = [${tomlString(serverPath)}]`,
  ];

  const keys = Object.keys(env);
  if (keys.length > 0) {
    out.push('', `[mcp_servers.${serverName}.env]`);
    for (const key of keys) out.push(`${key} = ${tomlString(env[key])}`);
  }

  return `${out.join('\n')}\n`;
}

/**
 * Merge this server into an existing config.toml, leaving everything else
 * exactly as it was.
 *
 * Pure, so the dangerous case has a test: Codex ships its own `node_repl`
 * server and users may add others, and setup silently dropping them would be a
 * far worse bug than failing to install.
 *
 * Re-running is an update, not a duplicate — the old block is removed first, so
 * "I moved the folder" is repaired by running Setup again, exactly as on the
 * Claude side.
 *
 * @returns {{text: string, replacedExisting: boolean, preservedServers: string[]}}
 */
export function mergeServerIntoToml(existingToml, options) {
  const serverName = options.serverName ?? CODEX_SERVER_KEY;
  const target = `mcp_servers.${serverName}`;
  const source = typeof existingToml === 'string' ? existingToml : '';

  const kept = [];
  const preservedServers = new Set();
  let dropping = false;
  let replacedExisting = false;

  for (const raw of source.split(/\r?\n/)) {
    const header = /^\s*\[\s*([^\]]+?)\s*\]\s*$/.exec(raw);
    if (header) {
      const name = header[1].trim();
      // Our own block, and only our own: `mcp_servers.tally.env` belongs to us,
      // `mcp_servers.tallyother` does not — hence the trailing dot.
      dropping = name === target || name.startsWith(`${target}.`);
      if (dropping) replacedExisting = true;

      const other = /^mcp_servers\.([^.]+)/.exec(name);
      if (other && other[1] !== serverName) preservedServers.add(other[1]);
    }
    if (!dropping) kept.push(raw);
  }

  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();

  const head = kept.length > 0 ? `${kept.join('\n')}\n\n` : '';
  return {
    text: `${head}${renderServerBlock({ ...options, serverName })}`,
    replacedExisting,
    preservedServers: [...preservedServers],
  };
}

/**
 * `~/.codex/config.toml`.
 *
 * CODEX_HOME wins where it is set, because Codex itself honours it; otherwise
 * USERPROFILE, which is read rather than rebuilt from the user name because it
 * moves on roaming and domain-joined profiles — common in accounting offices.
 */
export function codexConfigPath(env = process.env) {
  const home = env.CODEX_HOME;
  if (home && home.trim().length > 0) return join(home, 'config.toml');

  const profile = env.USERPROFILE ?? env.HOME;
  if (profile && profile.trim().length > 0) return join(profile, '.codex', 'config.toml');

  return null;
}

/**
 * Is Codex on this machine?
 *
 * The `.codex` folder is the signal, because it exists as soon as Codex has run
 * once, and unlike the executable its location does not contain a build hash.
 * Used only to decide what to OFFER — never to block an install, since a user
 * who is about to install Codex should still be able to set it up.
 */
export function isCodexInstalled(env = process.env) {
  const configPath = codexConfigPath(env);
  if (!configPath) return false;
  const dir = configPath.slice(0, configPath.lastIndexOf('config.toml') - 1);
  return existsSync(configPath) || existsSync(dir);
}

/**
 * Is Claude Desktop on this machine?
 *
 * Its config folder appears once the app has run. Advisory only, same as above:
 * the config is written whether or not this returns true, because a user may be
 * setting up before first launch.
 */
export function isClaudeInstalled(env = process.env) {
  // The packaged (MSIX) build keeps its settings under %LOCALAPPDATA%\Packages,
  // so a machine carrying ONLY that build has no %APPDATA%\Claude at all and
  // would be reported as "Claude not found" while Claude is sitting in the task
  // bar. claudeConfigCandidates knows both locations; reusing it keeps the two
  // answers from drifting apart again.
  if (claudeConfigCandidates(env).some((entry) => entry.present)) return true;

  // The unpackaged installer's program folder, as a last resort: it exists even
  // if the app has never been launched, and therefore has no settings yet.
  return env.LOCALAPPDATA ? existsSync(join(env.LOCALAPPDATA, 'AnthropicClaude')) : false;
}

/**
 * Best-effort path to codex.exe, for the "now restart it" instruction only.
 *
 * Nothing depends on finding it — the config is written directly. It is worth
 * looking because the desktop build hides it behind a per-version hash, so a
 * user told to "run codex" may not have it on PATH at all.
 */
export function findCodexExecutable(env = process.env) {
  const local = env.LOCALAPPDATA;
  if (!local) return null;
  const binRoot = join(local, 'OpenAI', 'Codex', 'bin');
  if (!existsSync(binRoot)) return null;

  try {
    for (const entry of readdirSync(binRoot)) {
      const candidate = join(binRoot, entry, 'codex.exe');
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // Unreadable directory is not an error: this is a convenience lookup.
  }
  return null;
}
