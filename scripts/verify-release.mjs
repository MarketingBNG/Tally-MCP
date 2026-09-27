#!/usr/bin/env node
/**
 * Check a published release the way an installed copy will see it.
 *
 *   npm run verify:release            -- the version in package.json
 *   npm run verify:release -- 1.0.2   -- a specific one
 *
 * ## Why this exists
 *
 * 1.0.2 was published and looked perfectly healthy on GitHub — both assets
 * listed, both "uploaded" — while no install could take it. The first zip upload
 * was lost by GitHub's storage (the download link returned 404), and the copy
 * uploaded to replace it was a different build from the one SHA256SUMS.txt
 * described. Every install's updater downloaded it, found the checksum did not
 * match, and rightly discarded it. Nothing in the release steps would ever have
 * shown that; laptops would simply have stayed on the old version.
 *
 * So this downloads both assets from the PUBLIC links, exactly as update.mjs
 * does, and confirms the zip matches the published checksum. It retries for a
 * few minutes because GitHub's download links can serve a replaced file's old
 * copy briefly after an upload.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version =
  process.argv[2] ?? JSON.parse(readFileSync(`${ROOT}/package.json`, 'utf8')).version;
const base = `https://github.com/MarketingBNG/Tally-MCP/releases/download/v${version}`;
const zipName = `TallyPrime-for-Claude-${version}.zip`;

const ATTEMPTS = 10;
const DELAY_MS = 20_000;

async function once() {
  const sums = await fetch(`${base}/SHA256SUMS.txt`, { redirect: 'follow' });
  if (!sums.ok) return `SHA256SUMS.txt could not be downloaded (HTTP ${String(sums.status)})`;
  const line = (await sums.text()).split(/\r?\n/).find((l) => l.trim().endsWith(zipName));
  const expected = line?.trim().split(/\s+/)[0]?.toLowerCase();
  if (expected === undefined) return `SHA256SUMS.txt does not list ${zipName}`;

  const zip = await fetch(`${base}/${zipName}`, { redirect: 'follow' });
  if (!zip.ok) return `${zipName} could not be downloaded (HTTP ${String(zip.status)})`;
  const actual = createHash('sha256')
    .update(Buffer.from(await zip.arrayBuffer()))
    .digest('hex');
  if (actual !== expected) {
    return `${zipName} does not match SHA256SUMS.txt (published ${expected.slice(0, 12)}…, downloaded ${actual.slice(0, 12)}…)`;
  }
  return null;
}

let problem = null;
for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  problem = await once();
  if (problem === null) {
    console.log(`v${version}: OK — the published zip matches its checksum. Installs can update.`);
    process.exit(0);
  }
  console.log(`  attempt ${String(attempt)}: ${problem}`);
  if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, DELAY_MS));
}

console.error(
  `\nv${version} is BROKEN for installs: ${String(problem)}\n` +
    'Re-upload BOTH files from release/ together, then run this again:\n' +
    `  gh release upload v${version} release/${zipName} release/SHA256SUMS.txt --clobber`
);
process.exit(1);
