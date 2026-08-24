import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error - plain ESM helper, shipped without type declarations because
// it must run under the bundled Node runtime with no build step.
import { notifyOnce, TOLD_FILE_NAME } from '../../installer/scripts/lib/notifyOnce.mjs';

/**
 * "TallyPrime was not open" is notified ONCE and then never again — not once
 * per evening, and not again on the next recovery. The whole value of the rule
 * is in the "never again", so that is what these pin: a second call is silent,
 * and so is a call after the condition cleared and came back.
 *
 * The toast itself is injected. What matters here is the bookkeeping around it,
 * and a test that actually raised Windows notifications would be untrustworthy
 * on a machine where they are disabled by policy.
 */

let installRoot: string;
let exportFolder: string;
let raised: Array<[string, string]>;
const roots: string[] = [];

const raise = (title: string, message: string) => raised.push([title, message]);
const NOT_OPEN = 'TallyPrime was not open';

beforeEach(() => {
  const sandbox = mkdtempSync(join(tmpdir(), 'notify-once-'));
  roots.push(sandbox);
  installRoot = join(sandbox, 'install');
  exportFolder = join(sandbox, 'export');
  mkdirSync(installRoot);
  mkdirSync(exportFolder);
  raised = [];
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const notify = (reason = NOT_OPEN) => notifyOnce({ installRoot, exportFolder, reason, raise });

describe('telling somebody once that Tally was not open', () => {
  it('raises the first one, and says both that it will not repeat and what to do', () => {
    expect(notify()).toBe(true);

    expect(raised).toHaveLength(1);
    const [title, message] = raised[0];
    expect(title).toContain('TallyPrime');
    expect(message).toContain(NOT_OPEN);
    expect(message).toContain('not be told again');
    expect(message).toContain('Run-Export');
  });

  it('is silent every time after that — the point of the rule', () => {
    notify();
    for (let run = 0; run < 100; run += 1) expect(notify()).toBe(false);

    expect(raised).toHaveLength(1);
  });

  it('stays silent when Tally comes back and goes away again', () => {
    notify();
    // A successful export in between clears nothing on purpose: "we already
    // told them" has to outlive the condition, or this fires every evening.
    expect(notify()).toBe(false);
    expect(raised).toHaveLength(1);
  });

  it('records the reason where the user can find it, and delete it', () => {
    notify();

    const told = readFileSync(join(installRoot, TOLD_FILE_NAME), 'utf8');
    expect(told).toContain(NOT_OPEN);
    expect(told).toContain('Delete this file');
  });

  it('speaks again if the user deletes that file', () => {
    notify();
    rmSync(join(installRoot, TOLD_FILE_NAME));

    expect(notify()).toBe(true);
    expect(raised).toHaveLength(2);
  });

  it('still notifies about a DIFFERENT failure, and remembers both', () => {
    notify();

    expect(notify('the export folder could not be reached')).toBe(true);
    expect(raised).toHaveLength(2);
    expect(notify('the export folder could not be reached')).toBe(false);
    expect(notify()).toBe(false);
  });

  it('does not re-notify an install that was already told before the record moved', () => {
    // Pre-0.8.7 installs kept a one-line last-failure.txt in the export folder.
    writeFileSync(join(exportFolder, 'last-failure.txt'), NOT_OPEN, 'utf8');

    expect(notify()).toBe(false);
    expect(raised).toHaveLength(0);
  });

  it('never throws when the record cannot be written', () => {
    // No install folder at all: the write fails, and an export must not.
    expect(() =>
      notifyOnce({ installRoot: join(installRoot, 'gone'), exportFolder, reason: NOT_OPEN, raise })
    ).not.toThrow();
  });

  it('does not raise a toast it could not record, which would then repeat forever', () => {
    expect(
      notifyOnce({ installRoot: join(installRoot, 'gone'), exportFolder, reason: NOT_OPEN, raise })
    ).toBe(false);
    expect(raised).toHaveLength(0);
  });
});
