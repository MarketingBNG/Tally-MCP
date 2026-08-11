import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Guard against committing real accounting data.
 *
 * `tests/fixtures/` is committed; `samples/` is gitignored and holds
 * unredacted exports from a real, operating company. Fixtures are derived from
 * those samples by hand, and the first version of that redaction replaced the
 * names but kept the amounts — putting the company's actual turnover and
 * expense totals into a public repository.
 *
 * This test makes that mistake fail loudly instead of shipping. It compares
 * every figure and identifier in the fixtures against the real samples, and
 * fails on any value present in both.
 *
 * It **skips** when `samples/` is absent, which is the normal case for anyone
 * who has cloned the repo — there is nothing to compare against. That means it
 * only runs on a machine holding real data, which is precisely where the
 * mistake can be made.
 */

const fixturesDir = fileURLToPath(new URL('.', import.meta.url));
const samplesDir = fileURLToPath(new URL('../../samples', import.meta.url));

/**
 * Value shapes worth checking. Deliberately narrow: matching every number
 * would flag dates and small round figures that legitimately coincide, and a
 * check that cries wolf gets deleted.
 */
const PATTERNS: { label: string; regex: RegExp }[] = [
  // Monetary amounts of four or more digits with two decimals.
  { label: 'amount', regex: /\d{4,}\.\d{2}/g },
  // GUIDs and Tally's GUID-derived keys.
  { label: 'guid', regex: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{6,}/gi },
  // Bank/transaction reference codes: long mixed-case alphanumeric runs.
  { label: 'reference', regex: /\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{10,}\b/g },
];

function readAll(dir: string): string {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.xml'))
    .map((name) => readFileSync(`${dir}/${name}`, 'utf-8'))
    .join('\n');
}

describe('committed fixtures contain no real accounting data', () => {
  const hasSamples = existsSync(samplesDir);

  it.skipIf(!hasSamples)('shares no amount, GUID or reference with samples/', () => {
    const fixtures = readAll(fixturesDir);
    const samples = readAll(samplesDir);

    const leaks: string[] = [];

    for (const { label, regex } of PATTERNS) {
      for (const match of new Set(fixtures.match(regex) ?? [])) {
        if (samples.includes(match)) leaks.push(`${label}: ${match}`);
      }
    }

    expect(
      leaks,
      `These values appear in BOTH tests/fixtures/ (committed) and samples/ (real data).\n` +
        `Replace them in the fixtures with obviously-synthetic values, then update any test\n` +
        `asserting on them. See tests/fixtures/README.md.\n\n${leaks.join('\n')}`
    ).toEqual([]);
  });

  it('fixtures exist and are non-trivial', () => {
    // Guards the guard: if the fixture directory were emptied or renamed, the
    // comparison above would pass vacuously.
    const fixtures = readAll(fixturesDir);
    expect(fixtures.length).toBeGreaterThan(1000);
  });
});
