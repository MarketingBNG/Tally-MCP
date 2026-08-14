/**
 * When a statement's end date does NOT bind, what period does Tally actually return?
 *
 * Background. `known-limitations.md` records that a non-binding end date makes
 * the statement "accumulate to the financial year end", and the shipped caveat
 * tells the user their figures are a running total from their start date to that
 * year end. That wording is what a reader would put in a workpaper.
 *
 * probe-date-format.ts then measured, on MUDALS TECHNOLOGIES PRIVATE LIMITED
 * with fromDate 2024-04-01:
 *
 *   toDate 2024-07-31  ->   4 month rows   (April -> July)      end date bound
 *   toDate 2024-12-31  ->   9 month rows   (April -> December)  end date bound
 *   toDate 2024-06-30  ->  36 month rows   (April -> March)     end date ignored
 *   toDate 2024-09-30  ->  36 month rows   (April -> March)     end date ignored
 *
 * Thirty-six months is three years, not one. So either the "accumulates to the
 * financial year end" description is wrong on this company, or `fromDate` is
 * being discarded as well and the response covers the whole book. Those are very
 * different facts and the caveat can only be honest about one of them.
 *
 * `DSPPERIOD` carries a bare month name with no year, which is exactly why the
 * earlier run could not tell 2024-04..2027-03 apart from 2021-04..2024-03. So
 * this prints every label in order, and counts how many times the sequence
 * passes April — the number of April..March cycles present. Combined with the
 * company's own start date, that pins the span down.
 *
 * SAFETY: identical to probe-date-format.ts — the one verified `Cash Flow`
 * report ID, one request at a time, cache off, health probe between calls.
 * Only two requests are sent: one known-binding end date as a control, and one
 * known-non-binding end date, so the control proves the run is behaving before
 * anything is concluded from the other.
 *
 *   TALLY_PROBE_CONFIRM=yes npx tsx scripts/probe-nonbinding-span.ts
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

/** Every month label in the order Tally sent them. */
function periodLabels(body: string): string[] {
  return [
    ...body.matchAll(/<DSPPERIOD>([^<]*)<\/DSPPERIOD>/gi),
    ...body.matchAll(/"DSPPERIOD"\s*:\s*"([^"]*)"/gi),
  ].map((match) => (match[1] ?? '').trim());
}

/**
 * Any four-digit year appearing anywhere in the payload, in order of appearance.
 *
 * The month labels carry no year, but the report header or a column caption
 * often does. This is a hint rather than a measurement, so it is reported as
 * "years mentioned" and never used to assert a span on its own.
 */
function yearsMentioned(body: string): string[] {
  const years = new Set<string>();
  for (const match of body.matchAll(/\b(19|20)\d{2}\b/g)) years.add(match[0]);
  return [...years].sort();
}

async function main(): Promise<void> {
  if (process.env.TALLY_PROBE_CONFIRM !== 'yes') {
    console.error(
      'Refusing to run without confirmation. Save your work in TallyPrime, then:\n\n' +
        '  TALLY_PROBE_CONFIRM=yes npx tsx scripts/probe-nonbinding-span.ts'
    );
    process.exitCode = 1;
    return;
  }

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
  const booksFrom = company?.startingFrom ?? null;

  console.log(`Company:     ${company?.name ?? '(unknown)'}`);
  console.log(`Books start: ${booksFrom ?? '(not reported)'}\n`);

  const anchorYear = booksFrom === null ? 2024 : Number(booksFrom.slice(0, 4)) + 3;
  const from = `${String(anchorYear)}-${booksFrom === null ? '04-01' : booksFrom.slice(5)}`;

  const cases: { label: string; to: string }[] = [
    { label: 'control, end date BINDS (a 31st)', to: `${String(anchorYear)}-07-31` },
    { label: 'subject, end date IGNORED (a 30th)', to: `${String(anchorYear)}-06-30` },
  ];

  for (const { label, to } of cases) {
    console.log(`${label}`);
    console.log(`  request: ${from} .. ${to}`);

    try {
      const response = await client.send(
        buildReportRequest('Cash Flow', {
          fromDate: from,
          toDate: to,
          format: config.tallyPreferredFormat,
        }),
        'report'
      );

      const labels = periodLabels(response.body);
      // Each time the sequence returns to the month the books start in, a new
      // April..March cycle has begun. This is what distinguishes one year from three.
      const startMonth = labels[0] ?? '';
      const cycles = labels.filter((month) => month === startMonth).length;

      console.log(`  rows:    ${String(labels.length)}`);
      console.log(`  cycles:  ${String(cycles)} (times the sequence returns to "${startMonth}")`);
      console.log(`  years mentioned anywhere in payload: ${yearsMentioned(response.body).join(', ') || '(none)'}`);
      console.log(`  labels:  ${labels.join(', ')}`);
    } catch (error) {
      console.log(`  ERROR    ${(error as Error).message}`);
    }

    console.log('');

    if (!(await healthy())) {
      console.error('TallyPrime stopped answering. ABORTING.');
      process.exitCode = 1;
      return;
    }
  }

  console.log(
    [
      'Reading this:',
      '  - 3 cycles means the response spans three April..March years, so "accumulates to the',
      '    financial year end" is wrong and the shipped caveat understates the span.',
      '  - 1 cycle with 36 rows would mean the labels are not months at all and this whole',
      '    measurement approach is invalid — which is itself worth knowing before relying on it.',
      '  - The years mentioned are a HINT, not proof: a report header may name a year it does',
      '    not actually cover. Do not conclude a span from that line alone.',
    ].join('\n')
  );
}

await main();
