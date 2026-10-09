import { describe, it, expect } from 'vitest';
import {
  MISSING_RUNS_BEFORE_REMOVAL,
  stableLauncherPath,
  stableLauncherScript,
  taskBelongsTo,
  taskUpgradePlan,
  // @ts-expect-error -- plain ESM installer module, no type declarations
} from '../../installer/scripts/lib/exportSetup.mjs';

/**
 * The scheduled task's starter, and which tasks a copy may touch.
 *
 * The bug behind this (2026-10-09): a folder deleted without Uninstall left a
 * task that raised "Can not find script file" on every run. The starter lives
 * outside the folder so it can remove the task once the folder is gone.
 */

const B = String.fromCharCode(92);
const win = (...parts: string[]): string => parts.join(B);
const ROOT = win('C:', 'Users', 'a', 'TallyPrime for Claude');
const HIDDEN = win(ROOT, 'Run-Export-Hidden.vbs');
const STABLE: string = stableLauncherPath() ?? '';

function taskXml(command: string, args: string, interval = 'PT15M'): string {
  return [
    '<Task>',
    `<Interval>${interval}</Interval>`,
    `<Command>${command}</Command>`,
    `<Arguments>${args.replace(/"/g, '&quot;')}</Arguments>`,
    '</Task>',
  ].join('');
}

const WSCRIPT = win('C:', 'WINDOWS', 'System32', 'wscript.exe');

describe('the starter script', () => {
  const script: string = stableLauncherScript(HIDDEN);

  it('runs the export while the folder is there, silently', () => {
    expect(script).toContain(`target = "${HIDDEN}"`);
    expect(script).toContain('wscript.exe //B //Nologo');
  });

  it('removes the task only after several runs find the folder gone', () => {
    expect(MISSING_RUNS_BEFORE_REMOVAL).toBeGreaterThan(1);
    expect(script).toContain(`If misses < ${String(MISSING_RUNS_BEFORE_REMOVAL)} Then`);
    expect(script).toContain('schtasks.exe /Delete /TN ""TallyPrime for Claude - Export"" /F');
  });

  it('never counts a drive that is not connected as a deletion', () => {
    expect(script.indexOf('IsReady')).toBeLessThan(script.indexOf('misses = misses + 1'));
  });
});

describe('which task belongs to this copy', () => {
  it('recognises a task that runs this folder directly', () => {
    expect(taskBelongsTo(taskXml(WSCRIPT, `"${HIDDEN}"`), ROOT, null)).toBe(true);
  });

  it('recognises one that runs the starter written for this folder', () => {
    const xml = taskXml(WSCRIPT, `//B //Nologo "${STABLE}"`);
    expect(taskBelongsTo(xml, ROOT, stableLauncherScript(HIDDEN))).toBe(true);
    const other = stableLauncherScript(win('D:', 'other', 'Run-Export-Hidden.vbs'));
    expect(taskBelongsTo(xml, ROOT, other)).toBe(false);
  });

  it('does not claim a sibling folder that shares the name prefix', () => {
    const sibling = win(`${ROOT} (old)`, 'Run-Export-Hidden.vbs');
    expect(taskBelongsTo(taskXml(WSCRIPT, `"${sibling}"`), ROOT, null)).toBe(false);
  });
});

describe('upgrading an installed task', () => {
  it('moves an old direct task onto the starter, at fifteen minutes', () => {
    expect(taskUpgradePlan(taskXml(WSCRIPT, `"${HIDDEN}"`, 'PT5M'), ROOT, null)).toEqual({
      everyMinutes: 15,
    });
    expect(taskUpgradePlan(taskXml(WSCRIPT, `"${HIDDEN}"`), ROOT, null)).toEqual({ everyMinutes: 15 });
  });

  it('keeps a longer interval somebody chose', () => {
    expect(taskUpgradePlan(taskXml(WSCRIPT, `"${HIDDEN}"`, 'PT1H'), ROOT, null)).toEqual({
      everyMinutes: 60,
    });
  });

  it('leaves a task that is already current, or belongs to another copy', () => {
    const current = taskXml(WSCRIPT, `//B //Nologo "${STABLE}"`);
    expect(taskUpgradePlan(current, ROOT, stableLauncherScript(HIDDEN))).toBeNull();
    const other = win('D:', 'other', 'Run-Export-Hidden.vbs');
    expect(taskUpgradePlan(taskXml(WSCRIPT, `"${other}"`, 'PT5M'), ROOT, null)).toBeNull();
  });
});
