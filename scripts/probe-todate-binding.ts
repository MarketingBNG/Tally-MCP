/**
 * Establish, per company, what period a statement ACTUALLY covers.
 *
 * Background. `known-limitations.md` records that `Trial Balance`,
 * `Profit and Loss` and `Cash Flow` honour `SVFROMDATE` and ignore `SVTODATE`,
 * accumulating to the financial year end. That was verified live, and the
 * shipped mitigation (refuse mid-year comparison, flag mid-year statements)
 * rests on it.
 *
 * Then a calendar-year company contradicted it. Against AGBV Nutrition GmbH,
 * a 3-month Cash Flow request returned 3 months and a 2-month request returned
 * 2 months — the end date appearing to bind — while a 6-month request returned
 * 36. Both cannot be explained by one rule, and the difference decides whether
 * the comparison guard is protecting users or blocking valid work.
 *
 * So this sweeps `toDate` across a range with the cache OFF and prints the row
 * count for each, which is the observable that reveals the covered period. It
 * asserts nothing and concludes nothing; it produces the table a conclusion can
 * be drawn from.
 *
 * `Cash Flow` is used because it returns ONE ROW PER MONTH, so the row count is
 * a direct readout of the span Tally chose. A balance report would total
 * silently and reveal nothing.
 *
 * SAFETY: one verified report ID (`Cash Flow`, in the server's own allowlist and
 * used in production), sent through the server's own builder, one request at a
 * time, with a health probe between every call. No unknown IDs, no collections.
 *
 *   TALLY_PROBE_CONFIRM=yes npx tsx scripts/probe-todate-binding.ts
 */

import { loadConfig } from '../src/config/config.js';
import { createLogger } from '../src/utils/logger.js';
import { TallyClient } from '../src/tally/TallyClient.js';
import {
  buildCompanyListRequest,
  buildConnectionProbeRequest,
  buildReportRequest,
} from '../src/tally/requests.js';
import { normalizeCompanies } from '../src/tally/normalize.js';

/** Requests to sweep. fromDate is held constant so only the end date varies. */
const FROM = '2024-01-01';
const TO_DATES = [
  '2024-01-31',
  '2024-02-29',
  '2024-03-31',
  '2024-04-30',
  '2024-05-31',
  '2024-06-30',
  '2024-09-30',
  '2024-12-31',
  '2025-12-31',
  '2026-12-31',
];

/** A second sweep with a LATER start, to separate "span" effects from "end" effects. */
const SECOND_FROM = '2024-06-01';
const SECOND_TO_DATES = ['2024-06-30', '2024-08-31', '2024-12-31'];

/**
 * Third sweep, to discriminate between two rules that fit the first sweep
 * equally well: "the end date binds when its day is the 31st" and "the end date
 * binds when it is the last day of its month".
 *
 * `2024-11-30` is the discriminator — last day of November, but not a 31st.
 * Under the first rule it is ignored; under the second it binds. The rest are
 * controls around it: mid-month dates, a 30th inside a 31-day month, and two
 * known-binding 31sts to confirm the run is behaving.
 */
const THIRD_FROM = '2024-01-01';
const THIRD_TO_DATES = [
  '2024-11-30',
  '2024-03-15',
  '2024-03-30',
  '2024-02-28',
  '2024-07-31',
  '2024-08-31',
];

/**
 * Count month rows without parsing amounts.
 *
 * Deliberately counts a structural marker rather than normalising the report:
 * this script must report what Tally sent, not what the server's parser makes
 * of it, or a parser bug would be invisible here. Real figures are never
 * printed — only counts and month names, which are not company data.
 */
function monthRows(body: string): { count: number; first: string; last: string } {
  // DSPPERIOD is the month label on both flow reports — the same marker
  // normalizeMonthlyFlow pairs on. Matched in either wire format, since the
  // preferred format is configurable and this must not depend on it.
  const names = [
    ...body.matchAll(/<DSPPERIOD>([^<]*)<\/DSPPERIOD>/gi),
    ...body.matchAll(/"DSPPERIOD"\s*:\s*"([^"]*)"/gi),
  ].map((m) => m[1]);
  return {
    count: names.length,
    first: names[0] ?? '-',
    last: names[names.length - 1] ?? '-',
  };
}

async function main(): Promise<void> {
  if (process.env.TALLY_PROBE_CONFIRM !== 'yes') {
    console.error(
      'Refusing to run without confirmation. Save your work in TallyPrime, then:\n\n' +
        '  TALLY_PROBE_CONFIRM=yes npx tsx scripts/probe-todate-binding.ts'
    );
    process.exitCode = 1;
    return;
  }

  // Cache OFF. With it on, repeated sweeps would be answered from memory and the
  // table would be an artefact of the cache rather than of Tally.
  const config = loadConfig({ ...process.env, TALLY_TIMEOUT_MS: '20000', TALLY_CACHE_TTL_MS: '0' });
  const client = new TallyClient(config, createLogger('error'));

  const healthy = async (): Promise<boolean> => {
    try {
      await client.send(buildConnectionProbeRequest(), 'standard', { bypassCache: true });
      return true;
    } catch {
      return false;
    }
  };

  if (!(await healthy())) {
    console.error('TallyPrime did not answer the initial health probe. Nothing was sent.');
    process.exitCode = 1;
    return;
  }

  const companies = normalizeCompanies(
    (await client.send(buildCompanyListRequest(), 'standard')).body
  ).data;
  const company = companies[0];
  console.log(`Company: ${company?.name ?? '(unknown)'}`);
  console.log(`Books start: ${company?.startingFrom ?? '(not reported)'}\n`);

  const sweep = async (from: string, toDates: string[]): Promise<void> => {
    console.log(`fromDate held at ${from}`);
    console.log('  toDate        rows  first -> last');
    for (const to of toDates) {
      try {
        const response = await client.send(
          buildReportRequest('Cash Flow', {
            fromDate: from,
            toDate: to,
            format: config.tallyPreferredFormat,
          }),
          'report'
        );
        const { count, first, last } = monthRows(response.body);
        console.log(`  ${to}  ${String(count).padStart(4)}  ${first} -> ${last}`);
      } catch (error) {
        console.log(`  ${to}   ERROR  ${(error as Error).message}`);
      }

      if (!(await healthy())) {
        console.error('\nTallyPrime stopped answering. ABORTING.');
        process.exitCode = 1;
        return;
      }
    }
    console.log('');
  };

  await sweep(FROM, TO_DATES);
  await sweep(SECOND_FROM, SECOND_TO_DATES);
  await sweep(THIRD_FROM, THIRD_TO_DATES);

  console.log(
    [
      'Reading this: if rows track the requested end date, SVTODATE binds on this company.',
      'If rows stay constant regardless of toDate, it is ignored and everything accumulates',
      'to whatever that constant span is. A mixture means the rule depends on something else,',
      'and THAT is the finding — the guard cannot assume either behaviour.',
    ].join('\n')
  );
}

await main();
