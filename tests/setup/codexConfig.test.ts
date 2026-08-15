import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
// @ts-expect-error -- plain .mjs installer helper, deliberately not TypeScript.
import {
  mergeServerIntoToml,
  renderServerBlock,
  tomlString,
  codexConfigPath,
} from '../../installer/scripts/lib/codexConfig.mjs';

/**
 * Writing into Codex's config.toml.
 *
 * The case that matters is not "does it add our block" — it is "does it leave
 * everything else alone". Codex ships its own `node_repl` server, and a user
 * may have added others; setup silently dropping them would be a worse bug than
 * failing to install at all, and it would surface days later as an unrelated
 * tool going missing.
 */

const OPTIONS = {
  nodePath: 'C:\\Users\\A B\\Documents\\TallyPrime for Claude\\node\\node.exe',
  serverPath: 'C:\\Users\\A B\\Documents\\TallyPrime for Claude\\dist\\index.js',
  env: { TALLY_HOST: '127.0.0.1', TALLY_PORT: '9000' },
};

const EXISTING = `notify = [ "something" ]

[mcp_servers.node_repl]
args = []
command = 'C:\\Codex\\node_repl.exe'

[mcp_servers.node_repl.env]
CODEX_HOME = 'C:\\Users\\A B\\.codex'

[features]
js_repl = false
`;

describe('Codex config.toml merge', () => {
  it('adds our server to an empty config', () => {
    const { text, replacedExisting } = mergeServerIntoToml('', OPTIONS);

    expect(replacedExisting).toBe(false);
    expect(text).toContain('[mcp_servers.tally]');
    expect(text).toContain('[mcp_servers.tally.env]');
    expect(text).toContain('TALLY_PORT = ');
  });

  /** The one that must never regress. */
  it("leaves Codex's own server and unrelated settings untouched", () => {
    const { text, preservedServers } = mergeServerIntoToml(EXISTING, OPTIONS);

    expect(preservedServers).toEqual(['node_repl']);
    expect(text).toContain('[mcp_servers.node_repl]');
    expect(text).toContain('[mcp_servers.node_repl.env]');
    expect(text).toContain("CODEX_HOME = 'C:\\Users\\A B\\.codex'");
    expect(text).toContain('[features]');
    expect(text).toContain('notify = [ "something" ]');
  });

  /**
   * Re-running Setup is the documented repair for "I moved the folder", so it
   * has to update in place. A second block would leave the OLD path in the file
   * and which one wins is anyone's guess.
   */
  it('replaces our own block instead of adding a second one', () => {
    const once = mergeServerIntoToml(EXISTING, OPTIONS).text;
    const twice = mergeServerIntoToml(once, {
      ...OPTIONS,
      serverPath: 'C:\\NewPlace\\dist\\index.js',
    });

    expect(twice.replacedExisting).toBe(true);
    expect(twice.text.match(/\[mcp_servers\.tally\]/g)).toHaveLength(1);
    expect(twice.text).toContain('C:\\NewPlace\\dist\\index.js');
    expect(twice.text).not.toContain('TallyPrime for Claude\\dist\\index.js');
    // and still has not eaten the neighbour
    expect(twice.text).toContain('[mcp_servers.node_repl]');
  });

  /** A trailing dot matters: `tallyother` is somebody else's server. */
  it('does not treat a similarly-named server as ours', () => {
    const other = `[mcp_servers.tallyother]\ncommand = 'x.exe'\n`;
    const { text, preservedServers } = mergeServerIntoToml(other, OPTIONS);

    expect(preservedServers).toEqual(['tallyother']);
    expect(text).toContain('[mcp_servers.tallyother]');
    expect(text).toContain("command = 'x.exe'");
  });

  /**
   * Windows paths are full of backslashes. A TOML *literal* string (single
   * quotes) takes them as-is; a basic string would need every one escaped, and
   * one missed escape is a config that parses to a wrong path rather than an
   * error.
   */
  it('writes Windows paths as literal strings, unescaped', () => {
    expect(tomlString('C:\\a\\b.exe')).toBe("'C:\\a\\b.exe'");
  });

  /** A literal string cannot hold a quote, so that case has to switch form. */
  it("falls back to an escaped basic string when the path contains a quote", () => {
    expect(tomlString("C:\\it's\\node.exe")).toBe('"C:\\\\it\'s\\\\node.exe"');
  });

  it('renders args as an array, which is what Codex expects', () => {
    const block = renderServerBlock({ ...OPTIONS, serverName: 'tally' });
    expect(block).toMatch(/args = \['.*index\.js'\]/);
  });

  /*
   * Separators come from node:path, so they follow the RUNNER, not the string
   * that was passed in: on Linux `join('D:\\codexhome', 'config.toml')` yields
   * `D:\codexhome/config.toml`. This test used to hard-code backslashes and so
   * passed on Windows and failed on Ubuntu, which is a fact about the test
   * rather than about the code.
   *
   * What actually needs asserting is the decision this function makes — which
   * variable wins, and that the fallback goes through `.codex` — so that is
   * asserted on every platform, with the separator left to node:path. The
   * Windows spelling is then pinned separately, on Windows, because that is
   * the platform the installer ships to and the one where a wrong separator
   * would reach a user.
   */
  it('honours CODEX_HOME over the user profile', () => {
    const home = process.platform === 'win32' ? 'D:\\codexhome' : '/codexhome';
    const profile = process.platform === 'win32' ? 'C:\\Users\\A' : '/home/a';

    expect(codexConfigPath({ CODEX_HOME: home, USERPROFILE: profile })).toBe(
      join(home, 'config.toml')
    );
  });

  it('falls back to the user profile, via .codex', () => {
    const profile = process.platform === 'win32' ? 'C:\\Users\\A' : '/home/a';

    expect(codexConfigPath({ USERPROFILE: profile })).toBe(
      join(profile, '.codex', 'config.toml')
    );
  });

  it('reads HOME where there is no USERPROFILE, so it works off Windows too', () => {
    expect(codexConfigPath({ HOME: '/home/a' })).toBe(join('/home/a', '.codex', 'config.toml'));
  });

  it('returns null rather than guessing when neither is set', () => {
    // Null is what makes setup say it cannot find Codex, instead of writing a
    // config file to a path assembled out of nothing.
    expect(codexConfigPath({})).toBeNull();
    expect(codexConfigPath({ CODEX_HOME: '   ' })).toBeNull();
  });

  it.runIf(process.platform === 'win32')('spells Windows paths with backslashes', () => {
    // The guarantee that matters to the shipped installer.
    expect(codexConfigPath({ CODEX_HOME: 'D:\\codexhome' })).toBe('D:\\codexhome\\config.toml');
    expect(codexConfigPath({ USERPROFILE: 'C:\\Users\\A' })).toBe(
      'C:\\Users\\A\\.codex\\config.toml'
    );
  });
});
