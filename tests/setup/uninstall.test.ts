import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain ESM installer module, no type declarations
import { removeServerFromConfig } from '../../installer/scripts/lib/configMerge.mjs';
// @ts-expect-error -- plain ESM installer module, no type declarations
import { mergeServerIntoToml, removeServerFromToml } from '../../installer/scripts/lib/codexConfig.mjs';

/**
 * Uninstall takes out this install's connection and nothing else. The case
 * that must never happen is the same as Setup's: losing a connection somebody
 * else set up, or breaking a working copy in another folder.
 */

// Built with join rather than written out, so the separators are unambiguous.
const win = (...parts: string[]): string => parts.join(String.fromCharCode(92));
const ROOT = win('C:', 'Users', 'a', 'TallyPrime for Claude');
const owns = (path: string): boolean => path.toLowerCase().startsWith(win(ROOT.toLowerCase(), ''));

const ours = { command: 'node.exe', args: [win(ROOT, 'launch.mjs')], env: {} };

describe('removing the Claude Desktop connection', () => {
  it('removes ours and keeps every other connection and setting', () => {
    const { config, outcome } = removeServerFromConfig(
      { theme: 'dark', mcpServers: { tally: ours, gmail: { command: 'x' } } },
      owns
    );
    expect(outcome).toBe('removed');
    expect(config).toEqual({ theme: 'dark', mcpServers: { gmail: { command: 'x' } } });
  });

  it('leaves a tally connection that points at another copy', () => {
    const other = { ...ours, args: [win('D:', 'elsewhere', 'launch.mjs')] };
    const { config, outcome } = removeServerFromConfig({ mcpServers: { tally: other } }, owns);
    expect(outcome).toBe('not-ours');
    expect(config).toEqual({ mcpServers: { tally: other } });
  });

  it('does not mistake a sibling folder sharing the name prefix for ours', () => {
    const sibling = { ...ours, args: [win(`${ROOT} (old)`, 'launch.mjs')] };
    expect(removeServerFromConfig({ mcpServers: { tally: sibling } }, owns).outcome).toBe('not-ours');
  });

  it('reports a file with no connection as such', () => {
    expect(removeServerFromConfig({ mcpServers: {} }, owns).outcome).toBe('absent');
    expect(removeServerFromConfig({}, owns).outcome).toBe('absent');
  });
});

describe('removing the Codex connection', () => {
  const others = "model = 'x'\n\n[mcp_servers.node_repl]\ncommand = 'node'\n";

  it('removes exactly the block Setup wrote, env table included', () => {
    const { text: installed } = mergeServerIntoToml(others, {
      nodePath: 'node.exe',
      serverPath: win(ROOT, 'launch.mjs'),
      env: { TALLY_PORT: '9000' },
    });
    const { text, outcome } = removeServerFromToml(installed, owns);
    expect(outcome).toBe('removed');
    expect(text).toBe(others);
  });

  it('reads back a path that needed a basic string', () => {
    const { text: installed } = mergeServerIntoToml('', {
      nodePath: 'node.exe',
      serverPath: win(ROOT, "it's", 'launch.mjs'),
      env: {},
    });
    expect(removeServerFromToml(installed, owns).outcome).toBe('removed');
  });

  it('leaves a block that points at another copy, and the file untouched', () => {
    const { text: installed } = mergeServerIntoToml(others, {
      nodePath: 'node.exe',
      serverPath: win('D:', 'elsewhere', 'launch.mjs'),
      env: {},
    });
    const { text, outcome } = removeServerFromToml(installed, owns);
    expect(outcome).toBe('not-ours');
    expect(text).toBe(installed);
  });

  it('reports a file with no connection as such', () => {
    expect(removeServerFromToml(others, owns)).toEqual({ text: others, outcome: 'absent' });
  });
});
