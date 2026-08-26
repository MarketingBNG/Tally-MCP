import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error -- plain ESM helper with no type declarations, by design.
import { promoteIfIdle, claudeIsRunning } from '../../installer/promote.mjs';

/**
 * The promotion that happens while Claude is closed, so an install that is never
 * restarted still updates. The property being defended is the same one the
 * updater defends: any doubt means the working install is left exactly alone.
 */

let root: string;

/** A payload folder holding the four things both promoters check for. */
function makePayload(dir: string, version: string, { complete = true } = {}): void {
  mkdirSync(join(dir, 'dist'), { recursive: true });
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(dir, 'dist', 'index.js'), '// server');
  if (complete) writeFileSync(join(dir, 'scripts', 'export.mjs'), '// export');
}

const closed = () => false;
const open = () => true;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tally-promote-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('deciding whether this is a safe moment', () => {
  it('does nothing when no update is staged', () => {
    makePayload(join(root, 'app'), '0.8.6');
    const result = promoteIfIdle({ root, isClaudeRunning: closed });
    expect(result.promoted).toBeNull();
    expect(result.reason).toBe('nothing staged');
  });

  it('leaves a staged update alone while Claude is open', () => {
    makePayload(join(root, 'app'), '0.8.6');
    makePayload(join(root, 'app.next'), '0.8.9');

    const result = promoteIfIdle({ root, isClaudeRunning: open });

    expect(result.promoted).toBeNull();
    expect(result.reason).toBe('Claude is open');
    // Untouched, both of them. launch.mjs promotes at the next Claude start.
    expect(readFileSync(join(root, 'app', 'package.json'), 'utf-8')).toContain('0.8.6');
    expect(existsSync(join(root, 'app.next'))).toBe(true);
  });

  it('treats an unanswerable "is Claude running" as running', () => {
    // Fails closed: tasklist missing or blocked by policy must not become
    // permission to move somebody's install.
    expect(claudeIsRunning(() => { throw new Error('tasklist not found'); })).toBe(true);
    expect(claudeIsRunning(() => 42 as unknown as string)).toBe(true);
  });

  it('reads a tasklist listing either way round', () => {
    expect(claudeIsRunning(() => 'Claude.exe   1234 Console   1   250,000 K')).toBe(true);
    expect(claudeIsRunning(() => 'INFO: No tasks are running which match the specified criteria.')).toBe(false);
  });
});

describe('promoting', () => {
  it('swaps the staged version in and keeps the old one', () => {
    makePayload(join(root, 'app'), '0.8.6');
    makePayload(join(root, 'app.next'), '0.8.9');

    const result = promoteIfIdle({ root, isClaudeRunning: closed });

    expect(result).toEqual({ promoted: '0.8.9', reason: 'promoted' });
    expect(readFileSync(join(root, 'app', 'package.json'), 'utf-8')).toContain('0.8.9');
    expect(readFileSync(join(root, 'app.previous', 'package.json'), 'utf-8')).toContain('0.8.6');
    expect(existsSync(join(root, 'app.next'))).toBe(false);
  });

  it('clears the staged marker so the next check does not think one is waiting', () => {
    makePayload(join(root, 'app'), '0.8.6');
    makePayload(join(root, 'app.next'), '0.8.9');
    writeFileSync(
      join(root, 'update-state.json'),
      JSON.stringify({ staged: '0.8.9', stagedAt: '2026-08-24T00:00:00.000Z', refuse: null })
    );

    promoteIfIdle({ root, isClaudeRunning: closed });

    const state = JSON.parse(readFileSync(join(root, 'update-state.json'), 'utf-8'));
    expect(state.staged).toBeNull();
    expect(state.stagedAt).toBeNull();
    expect(typeof state.promotedAt).toBe('string');
    // Untouched keys survive: a rollback refusal must not be forgotten here.
    expect(state).toHaveProperty('refuse', null);
  });

  it('replaces the "update ready" note with one naming the version now in use', () => {
    makePayload(join(root, 'app'), '0.8.6');
    makePayload(join(root, 'app.next'), '0.8.9');
    writeFileSync(join(root, 'UPDATE READY - version 0.8.9.txt'), 'waiting');

    promoteIfIdle({ root, isClaudeRunning: closed });

    const notes = readdirSync(root).filter((name) => name.endsWith('.txt'));
    expect(notes).toEqual(['UPDATED - now on version 0.8.9.txt']);
  });

  it('restores the install when app\\ is missing entirely', () => {
    // Should be impossible, but promoting into a gap is the one case that
    // otherwise leaves nothing runnable at all.
    makePayload(join(root, 'app.next'), '0.8.9');

    const result = promoteIfIdle({ root, isClaudeRunning: closed });

    expect(result.promoted).toBe('0.8.9');
    expect(readFileSync(join(root, 'app', 'package.json'), 'utf-8')).toContain('0.8.9');
  });
});

describe('refusing a payload that is not whole', () => {
  it('discards a half-extracted staged folder rather than promoting it', () => {
    makePayload(join(root, 'app'), '0.8.6');
    makePayload(join(root, 'app.next'), '0.8.9', { complete: false });

    const result = promoteIfIdle({ root, isClaudeRunning: closed });

    expect(result.promoted).toBeNull();
    expect(result.reason).toBe('the staged update was incomplete');
    // The working install is exactly as it was, and the bad folder is gone so
    // the next check re-stages rather than tripping over it forever.
    expect(readFileSync(join(root, 'app', 'package.json'), 'utf-8')).toContain('0.8.6');
    expect(existsSync(join(root, 'app.next'))).toBe(false);

    const state = JSON.parse(readFileSync(join(root, 'update-state.json'), 'utf-8'));
    expect(state.lastFailure).toBe('the staged update was incomplete');
  });

  it('refuses a staged folder whose version cannot be read', () => {
    makePayload(join(root, 'app'), '0.8.6');
    makePayload(join(root, 'app.next'), '0.8.9');
    writeFileSync(join(root, 'app.next', 'package.json'), '{ truncated');

    const result = promoteIfIdle({ root, isClaudeRunning: closed });

    // Structurally complete, but nothing could say WHICH version it is. Promoted
    // unattended that becomes a Check-Tally reading "version unknown" weeks
    // later, reported as "it broke on its own", so it is refused.
    expect(result.promoted).toBeNull();
    expect(result.reason).toBe('the staged update was incomplete');
    expect(readFileSync(join(root, 'app', 'package.json'), 'utf-8')).toContain('0.8.6');
  });
});
