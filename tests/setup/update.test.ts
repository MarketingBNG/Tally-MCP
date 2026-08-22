import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error -- plain ESM helper with no type declarations, by design.
import {
  chooseUpdate,
  compareVersions,
  digestFor,
  parseRelease,
  parseVersion,
  payloadIsComplete,
  readUpdateState,
  stageUpdate,
  checkForUpdate,
  versionOf,
} from '../../installer/scripts/lib/update.mjs';

/**
 * The property every test here is really defending: a failed update must leave a
 * working install working. Accountants cannot recover from a broken folder, so
 * "refuses to update" is always the correct answer to any doubt.
 */

describe('reading a version', () => {
  it('accepts x.y.z with or without the tag prefix', () => {
    expect(parseVersion('0.7.0')).toEqual({ major: 0, minor: 7, patch: 0 });
    expect(parseVersion('v0.7.0')).toEqual({ major: 0, minor: 7, patch: 0 });
  });

  it('refuses anything it cannot compare exactly', () => {
    // Each of these would compare WRONGLY under a loose parse, and a wrong
    // comparison either downgrades an install or freezes it forever.
    for (const bad of ['0.7', '0.7.0-rc1', '1.0.0.1', 'latest', '', 'v', null, 7]) {
      expect(parseVersion(bad as string)).toBeNull();
    }
  });

  it('compares by number, not by string', () => {
    // The bug this pins: '0.10.0' < '0.9.0' as strings, so a string comparison
    // would stop updating at 0.9 and never say why.
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('0.7.0', '0.7.0')).toBe(0);
    expect(compareVersions('0.7.0', 'nonsense')).toBeNull();
  });
});

describe('deciding whether to fetch', () => {
  it('fetches only a strictly newer version', () => {
    expect(chooseUpdate({ installed: '0.7.0', latest: '0.8.0' }).act).toBe(true);
    expect(chooseUpdate({ installed: '0.7.0', latest: '0.7.0' }).act).toBe(false);
  });

  it('never walks an install backwards', () => {
    // A release pulled after a bad build would otherwise reinstall an older
    // version over a newer one.
    const decision = chooseUpdate({ installed: '0.7.0', latest: '0.6.0' });
    expect(decision.act).toBe(false);
    expect(decision.reason).toBe('already-current');
  });

  it('does not re-download something already waiting', () => {
    const decision = chooseUpdate({ installed: '0.7.0', latest: '0.8.0', staged: '0.8.0' });
    expect(decision.act).toBe(false);
    expect(decision.reason).toBe('already-staged');
  });

  it('still fetches when a newer one appears than the one already staged', () => {
    expect(chooseUpdate({ installed: '0.7.0', latest: '0.9.0', staged: '0.8.0' }).act).toBe(true);
  });

  it('refuses a version that already failed to start once', () => {
    // Without this the install re-downloads the broken version every hour and
    // re-breaks itself at every restart.
    const decision = chooseUpdate({ installed: '0.7.0', latest: '0.8.0', refuse: '0.8.0' });
    expect(decision.act).toBe(false);
    expect(decision.reason).toBe('refused-after-rollback');
  });

  it('accepts a LATER version than the one that was refused', () => {
    // The fix for a bad release is the next release, so the refusal must not be
    // permanent.
    expect(chooseUpdate({ installed: '0.7.0', latest: '0.8.1', refuse: '0.8.0' }).act).toBe(true);
  });

  it('does nothing at all when either version is unreadable', () => {
    expect(chooseUpdate({ installed: 'who knows', latest: '0.8.0' }).act).toBe(false);
    expect(chooseUpdate({ installed: '0.7.0', latest: 'tip-of-main' }).act).toBe(false);
  });
});

describe('reading a published release', () => {
  const release = (over: Record<string, unknown> = {}) => ({
    tag_name: 'v0.8.0',
    draft: false,
    prerelease: false,
    assets: [
      {
        name: 'TallyPrime-for-Claude-0.8.0.zip',
        browser_download_url: 'https://example.invalid/app.zip',
      },
      { name: 'SHA256SUMS.txt', browser_download_url: 'https://example.invalid/sums.txt' },
    ],
    ...over,
  });

  it('picks out the zip and the checksum file', () => {
    expect(parseRelease(release())).toEqual({
      version: '0.8.0',
      zipName: 'TallyPrime-for-Claude-0.8.0.zip',
      zipUrl: 'https://example.invalid/app.zip',
      checksumUrl: 'https://example.invalid/sums.txt',
    });
  });

  it('refuses a release with no checksum file', () => {
    // The entire verification story rests on this file. Its absence means the
    // release cannot be trusted, not that it should be trusted over HTTPS.
    const noSums = release({
      assets: [
        {
          name: 'TallyPrime-for-Claude-0.8.0.zip',
          browser_download_url: 'https://example.invalid/app.zip',
        },
      ],
    });
    expect(parseRelease(noSums)).toBeNull();
  });

  it('ignores drafts and pre-releases', () => {
    expect(parseRelease(release({ draft: true }))).toBeNull();
    expect(parseRelease(release({ prerelease: true }))).toBeNull();
  });

  it('survives a response shape nobody anticipated', () => {
    // This runs inside the hourly export task, so a surprise from GitHub has to
    // become "no update today" and never an exception.
    for (const junk of [null, {}, { tag_name: 'v0.8.0' }, { tag_name: 'v0.8.0', assets: 'no' }]) {
      expect(parseRelease(junk as Record<string, unknown>)).toBeNull();
    }
  });
});

describe('finding a digest in a checksum listing', () => {
  const hash = 'a'.repeat(64);

  it('reads both the plain and the binary-marker spacing', () => {
    expect(digestFor(`${hash}  app.zip`, 'app.zip')).toBe(hash);
    expect(digestFor(`${hash} *app.zip`, 'app.zip')).toBe(hash);
  });

  it('matches on the base name, so a path prefix does not break it', () => {
    expect(digestFor(`${hash}  ./release/app.zip`, 'app.zip')).toBe(hash);
  });

  it('returns null when the file is not listed', () => {
    expect(digestFor(`${hash}  something-else.zip`, 'app.zip')).toBeNull();
    expect(digestFor('not a checksum file at all', 'app.zip')).toBeNull();
  });
});

describe('a payload folder', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'payload-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const completePayload = (root: string, version = '0.8.0') => {
    mkdirSync(join(root, 'dist'), { recursive: true });
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
    writeFileSync(join(root, 'dist', 'index.js'), '// server');
    writeFileSync(join(root, 'scripts', 'export.mjs'), '// exporter');
  };

  it('is complete only when every part is present', () => {
    completePayload(dir);
    expect(payloadIsComplete(dir)).toBe(true);
    expect(versionOf(dir)).toBe('0.8.0');
  });

  it('is INCOMPLETE when the archive stopped halfway', () => {
    // A half-extracted folder looks like an install and is not one. Caught here,
    // the failure is a skipped update; caught at Desktop start it is a tool that
    // will not open with nothing to explain why.
    completePayload(dir);
    rmSync(join(dir, 'node_modules'), { recursive: true });
    expect(payloadIsComplete(dir)).toBe(false);
  });

  it('is not a payload at all without a readable version', () => {
    completePayload(dir);
    writeFileSync(join(dir, 'package.json'), '{ truncated');
    expect(versionOf(dir)).toBeNull();
    expect(payloadIsComplete(dir)).toBe(false);
  });
});

describe('staging a download', () => {
  let root: string;
  let zipBytes: Buffer;

  /** A real zip of a real payload, so extraction is genuinely exercised. */
  const buildZip = (version: string): Buffer => {
    const scratch = mkdtempSync(join(tmpdir(), 'zipsrc-'));
    const inner = join(scratch, 'TallyPrime for Claude');
    mkdirSync(join(inner, 'dist'), { recursive: true });
    mkdirSync(join(inner, 'node_modules'), { recursive: true });
    mkdirSync(join(inner, 'scripts'), { recursive: true });
    writeFileSync(join(inner, 'package.json'), JSON.stringify({ version }));
    writeFileSync(join(inner, 'dist', 'index.js'), '// server');
    writeFileSync(join(inner, 'scripts', 'export.mjs'), '// exporter');

    // Built with Windows' own bsdtar by absolute path, for the same reason the
    // updater extracts that way: the `tar` on PATH here is Git's GNU tar, which
    // cannot handle zips and fails with "Cannot connect to C".
    const zipPath = join(scratch, 'app.zip');
    const bsdtar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(bsdtar, ['-a', '-c', '-f', zipPath, '-C', scratch, 'TallyPrime for Claude']);
    const bytes = readFileSync(zipPath);
    rmSync(scratch, { recursive: true, force: true });
    return bytes;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'install-'));
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(join(root, 'app', 'package.json'), JSON.stringify({ version: '0.7.0' }));
    zipBytes = buildZip('0.8.0');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const release = (name = 'TallyPrime-for-Claude-0.8.0.zip', version = '0.8.0') => ({
    version,
    zipName: name,
    zipUrl: 'https://example.invalid/app.zip',
    checksumUrl: 'https://example.invalid/sums.txt',
  });

  /** A fetch that serves the zip and a checksum listing of the caller's choosing. */
  const fetcher = (sums: string, bytes: Buffer = zipBytes) => (url: string) => {
    if (url.endsWith('sums.txt')) {
      return Promise.resolve({ ok: true, text: () => Promise.resolve(sums) });
    }
    return Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    });
  };

  const goodSums = () =>
    `${createHash('sha256').update(zipBytes).digest('hex')}  TallyPrime-for-Claude-0.8.0.zip`;

  it('stages a verified download beside the live install', async () => {
    const result = await stageUpdate({
      packageRoot: root,
      release: release(),
      fetchImpl: fetcher(goodSums()) as never,
    });

    expect(result).toEqual({ staged: '0.8.0' });
    expect(payloadIsComplete(join(root, 'app.next'))).toBe(true);
    // The live install is untouched — the property that matters most.
    expect(versionOf(join(root, 'app'))).toBe('0.7.0');
  });

  it('DISCARDS a download whose checksum does not match', async () => {
    const wrong = `${'b'.repeat(64)}  TallyPrime-for-Claude-0.8.0.zip`;
    const result = await stageUpdate({
      packageRoot: root,
      release: release(),
      fetchImpl: fetcher(wrong) as never,
    });

    expect(result.error).toMatch(/did not match its published checksum/);
    // Nothing was staged, and nothing was damaged.
    expect(existsSync(join(root, 'app.next'))).toBe(false);
    expect(versionOf(join(root, 'app'))).toBe('0.7.0');
  });

  it('refuses when the archive version disagrees with the release', async () => {
    // A release whose tag and contents disagree means the build or the upload
    // went wrong, and neither is something to install unattended.
    const mismatched = buildZip('0.9.0');
    const sums = `${createHash('sha256').update(mismatched).digest('hex')}  TallyPrime-for-Claude-0.8.0.zip`;

    const result = await stageUpdate({
      packageRoot: root,
      release: release(),
      fetchImpl: fetcher(sums, mismatched) as never,
    });

    expect(result.error).toMatch(/reports version 0\.9\.0 but the release says 0\.8\.0/);
    expect(existsSync(join(root, 'app.next'))).toBe(false);
  });

  it('reports a failed download rather than throwing', async () => {
    const failing = () => Promise.resolve({ ok: false, status: 404 });
    const result = await stageUpdate({
      packageRoot: root,
      release: release(),
      fetchImpl: failing as never,
    });
    expect(result.error).toMatch(/HTTP 404/);
  });
});

describe('the hourly check', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'check-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('says nothing is due when the install is current', async () => {
    const fetchImpl = () =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            tag_name: 'v0.7.0',
            assets: [
              {
                name: 'TallyPrime-for-Claude-0.7.0.zip',
                browser_download_url: 'https://example.invalid/a.zip',
              },
              { name: 'SHA256SUMS.txt', browser_download_url: 'https://example.invalid/s.txt' },
            ],
          }),
      });

    const result = await checkForUpdate({
      packageRoot: root,
      installed: '0.7.0',
      fetchImpl: fetchImpl as never,
    });
    expect(result).toEqual({ acted: false, reason: 'already-current', latest: '0.7.0' });
  });

  it('stays quiet and does not throw when GitHub cannot be reached', async () => {
    // An accountant on a locked-down network must not see an error every hour,
    // and the export this runs inside must not fail because of one.
    const offline = () => Promise.reject(new Error('getaddrinfo ENOTFOUND'));
    const result = await checkForUpdate({
      packageRoot: root,
      installed: '0.7.0',
      fetchImpl: offline,
    });

    expect(result.acted).toBe(false);
    expect(result.reason).toMatch(/could not reach the update service/);
  });

  it('records a staging failure so it is visible in the run log', async () => {
    const fetchImpl = (url: string) => {
      if (url.includes('api.github.com')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              tag_name: 'v0.9.0',
              assets: [
                {
                  name: 'TallyPrime-for-Claude-0.9.0.zip',
                  browser_download_url: 'https://example.invalid/a.zip',
                },
                { name: 'SHA256SUMS.txt', browser_download_url: 'https://example.invalid/s.txt' },
              ],
            }),
        });
      }
      return Promise.resolve({ ok: false, status: 500 });
    };

    const result = await checkForUpdate({
      packageRoot: root,
      installed: '0.7.0',
      fetchImpl: fetchImpl as never,
    });

    expect(result.acted).toBe(false);
    expect(readUpdateState(root).lastFailure).toMatch(/HTTP 500/);
  });
});

describe('not checking twice in a row', () => {
  const release = {
    tag_name: 'v0.9.0',
    assets: [
      {
        name: 'TallyPrime-for-Claude-0.9.0.zip',
        browser_download_url: 'https://example.invalid/a.zip',
      },
      { name: 'SHA256SUMS.txt', browser_download_url: 'https://example.invalid/s.txt' },
    ],
  };

  it('skips when the last check was inside the interval', async () => {
    // Two callers ask this question now — the hourly task and the server at
    // startup. Without the floor, opening Claude just after a scheduled run
    // downloads the same 40MB a second time.
    const root = mkdtempSync(join(tmpdir(), 'throttle-'));
    try {
      let calls = 0;
      const fetchImpl = () => {
        calls += 1;
        return Promise.resolve({ ok: true, json: () => Promise.resolve(release) });
      };

      const first = await checkForUpdate({
        packageRoot: root,
        installed: '0.9.0',
        fetchImpl: fetchImpl as never,
        now: new Date('2026-08-22T10:00:00Z'),
        minIntervalMinutes: 60,
      });
      expect(first.reason).toBe('already-current');

      const second = await checkForUpdate({
        packageRoot: root,
        installed: '0.9.0',
        fetchImpl: fetchImpl as never,
        now: new Date('2026-08-22T10:30:00Z'),
        minIntervalMinutes: 60,
      });

      expect(second.reason).toBe('checked recently');
      // The point: GitHub was asked once, not twice.
      expect(calls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('checks again once the interval has passed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'throttle2-'));
    try {
      const fetchImpl = () => Promise.resolve({ ok: true, json: () => Promise.resolve(release) });
      await checkForUpdate({
        packageRoot: root,
        installed: '0.9.0',
        fetchImpl: fetchImpl as never,
        now: new Date('2026-08-22T10:00:00Z'),
        minIntervalMinutes: 60,
      });
      const later = await checkForUpdate({
        packageRoot: root,
        installed: '0.9.0',
        fetchImpl: fetchImpl as never,
        now: new Date('2026-08-22T11:30:00Z'),
        minIntervalMinutes: 60,
      });
      expect(later.reason).toBe('already-current');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
