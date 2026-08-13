import { describe, it, expect } from 'vitest';
// @ts-expect-error - plain ESM helper, shipped without type declarations because
// it must run under the bundled Node runtime with no build step.
import { mergeServerIntoConfig, isPlainObject, SERVER_KEY } from '../../installer/scripts/lib/configMerge.mjs';

/**
 * These tests exist for one reason: this function edits a file that may already
 * contain MCP servers someone else set up. Registering ours is easy; not
 * destroying theirs is the part worth proving.
 */

const ENTRY = {
  nodePath: 'C:\\Tally for Claude\\node\\node.exe',
  serverPath: 'C:\\Tally for Claude\\dist\\index.js',
  env: { TALLY_HOST: '127.0.0.1', TALLY_PORT: '9000', LOG_LEVEL: 'info' },
};

describe('mergeServerIntoConfig', () => {
  it('creates the structure when there is no config yet', () => {
    const { config, replacedExisting, preservedServers } = mergeServerIntoConfig(null, ENTRY);

    expect(replacedExisting).toBe(false);
    expect(preservedServers).toEqual([]);
    expect(config).toEqual({
      mcpServers: {
        [SERVER_KEY]: {
          command: ENTRY.nodePath,
          args: [ENTRY.serverPath],
          env: ENTRY.env,
        },
      },
    });
  });

  it('preserves other MCP servers already configured', () => {
    const existing = {
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', 'server-filesystem'] },
        gdrive: { command: 'node', args: ['gdrive.js'] },
      },
    };

    const { config, preservedServers } = mergeServerIntoConfig(existing, ENTRY);

    expect(preservedServers.sort()).toEqual(['filesystem', 'gdrive']);
    expect(config.mcpServers.filesystem).toEqual(existing.mcpServers.filesystem);
    expect(config.mcpServers.gdrive).toEqual(existing.mcpServers.gdrive);
    expect(config.mcpServers[SERVER_KEY].args).toEqual([ENTRY.serverPath]);
  });

  it('preserves unrelated top-level settings', () => {
    const existing = { theme: 'dark', globalShortcut: 'Ctrl+Space' };

    const { config } = mergeServerIntoConfig(existing, ENTRY);

    expect(config.theme).toBe('dark');
    expect(config.globalShortcut).toBe('Ctrl+Space');
  });

  it('replaces a previous install of this server rather than duplicating it', () => {
    const existing = {
      mcpServers: {
        [SERVER_KEY]: {
          command: 'node',
          args: ['C:\\Old Location\\dist\\index.js'],
          env: { TALLY_PORT: '9000' },
        },
      },
    };

    const { config, replacedExisting } = mergeServerIntoConfig(existing, ENTRY);

    expect(replacedExisting).toBe(true);
    expect(Object.keys(config.mcpServers)).toEqual([SERVER_KEY]);
    // The whole point of re-running setup: the path is updated to this folder.
    expect(config.mcpServers[SERVER_KEY].args).toEqual([ENTRY.serverPath]);
    expect(config.mcpServers[SERVER_KEY].command).toBe(ENTRY.nodePath);
  });

  it('does not mutate the object it was given', () => {
    const existing = { mcpServers: { gdrive: { command: 'node' } } };
    const snapshot = structuredClone(existing);

    mergeServerIntoConfig(existing, ENTRY);

    expect(existing).toEqual(snapshot);
  });

  it('copies env rather than aliasing the caller\'s object', () => {
    const env = { TALLY_PORT: '9000' };
    const { config } = mergeServerIntoConfig(null, { ...ENTRY, env });

    env.TALLY_PORT = '9999';

    expect(config.mcpServers[SERVER_KEY].env.TALLY_PORT).toBe('9000');
  });

  it('survives an mcpServers key that is not an object', () => {
    // Seen in the wild when a config is hand-edited badly. Ours must still
    // register, and must not throw.
    const { config } = mergeServerIntoConfig({ mcpServers: 'broken' }, ENTRY);

    expect(config.mcpServers[SERVER_KEY].args).toEqual([ENTRY.serverPath]);
  });
});

describe('isPlainObject', () => {
  it('accepts only plain objects', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it('rejects arrays and null, which would silently erase a config', () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject('string')).toBe(false);
    expect(isPlainObject(42)).toBe(false);
  });
});
