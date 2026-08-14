/**
 * When a statement accumulates past its end date, WHERE does it actually stop?
 *
 * Background, all measured live against MUDALS TECHNOLOGIES PRIVATE LIMITED
 * (books 2021-04-01 .. 2026-07-28, today 2026-08-14):
 *
 *   - probe-date-format.ts: fromDate 2024-04-01 with a non-binding end date
 *     returned 36 month rows — three April..March cycles, not one.
 *   - The shipped warning on tally_get_statement says figures "accumulate from
 *     fromDate to the end of the company's financial year".
 *   - That same warning, asked for FY 2023-24, reported the figures as covering
 *     "2023-04-01 to 2022-03-31" — an end date BEFORE the start date.
 *
 * So the shipped rule is wrong in both directions: wrong span (one year, when
 * three were returned) and wrong arithmetic (an end before the start). A figure
 * presented as FY 2023-24 may in fact be a multi-year cumulative, which is the
 * most dangerous class of error this server can produce — a plausible number
 * with a confident label.
 *
 * This establishes the real rule by holding the end date at a NON-binding date
 * (a 30th, so it is always ignored) and sweeping the START date across the book.
 * Row counts then read out where Tally chose to stop:
 *
 *   If accumulation always ends at the close of the financial year containing
 *   the company's EndingAt (2026-07-28 -> 2027-03-31), the counts must be:
 *
 *     from 2021-04-01  ->  72 rows
 *     from 2023-04-01  ->  48 rows
 *     from 2024-04-01  ->  36 rows   (already observed)
 *     from 2025-04-01  ->  24 rows
 *     from 2026-04-01  ->  12 rows
 *
 *   Any other pattern falsifies that rule, and the actual counts are then the
 *   evidence for whatever the real one is. A binding control (a 31st) is included
 *   so a run that has stopped working cannot be mistaken for a finding.
 *
 * SAFETY: the one verified `Cash Flow` report ID, through the server's own
 * builder, one request at a time, cache off, health probe between every call.
 *
 *   TALLY_PROBE_CONFIRM=yes npx tsx scripts/probe-accumulation-end.ts
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

function monthRowCount(body: string): number {
  return [
    ...body.matchAll(/<DSPPERIOD>([^<]*)<\/DSPPERIOD>/gi),
    ...body.matchAll(/"DSPPERIOD"\s*:\s*"([^"]*)"/gi),
  ].length;
}

async function main(): Promise<void> {
  if (process.env.TALLY_PROBE_CONFIRM !== 'yes') {
    console.error(
      'Refusing to run without confirmation. Save your work in TallyPrime, then:\n\n' +
        '  TALLY_PROBE_CONFIRM=yes npx tsx scripts/probe-accumulation-end.ts'
    );
    process.exitCode = 1;
    return;
  }

  const config = loadConfig({ ...process.env, TALLY_TIMEOUT_MS: '30000', TALLY_CACHE_TTL_MS: '0' });
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
  console.log(`Company:     ${company?.name ?? '(unknown)'}`);
  console.log(`Books start: ${company?.startingFrom ?? '(not reported)'}`);
  console.log('Books end:   read separately from EndingAt; see findings notes.\n');

  // A 30th: established as never binding, so every row below is a pure readout
  // of where accumulation stops rather than of the requested end.
  const NON_BINDING_END = '06-30';

  const starts = ['2021-04-01', '2022-04-01', '2023-04-01', '2024-04-01', '2025-04-01', '2026-04-01'];

  console.log('Sweeping fromDate, end date held NON-BINDING (a 30th):');
  console.log('  fromDate      toDate        rows   implied end');
  for (const from of starts) {
    const year = from.slice(0, 4);
    const to = `${year}-${NON_BINDING_END}`;
    try {
      const response = await client.send(
        buildReportRequest('Cash Flow', {
          fromDate: from,
          toDate: to,
          format: config.tallyPreferredFormat,
        }),
        'report'
      );
      const rows = monthRowCount(response.body);
      // Months are counted forward from fromDate, so the implied end is
      // arithmetic on the count rather than anything Tally stated.
      const startYear = Number(year);
      const startMonth = Number(from.slice(5, 7));
      const endMonthIndex = startMonth - 1 + rows - 1;
      const impliedEnd =
        rows === 0
          ? '(no rows)'
          : `${String(startYear + Math.floor(endMonthIndex / 12))}-${String((endMonthIndex % 12) + 1).padStart(2, '0')}`;
      console.log(`  ${from}    ${to}  ${String(rows).padStart(4)}   ${impliedEnd}`);
    } catch (error) {
      console.log(`  ${from}    ${to}   ERROR  ${(error as Error).message}`);
    }

    if (!(await healthy())) {
      console.error('\nTallyPrime stopped answering. ABORTING.');
      process.exitCode = 1;
      return;
    }
  }

  console.log('\nBinding control (a 31st) — must return exactly the months requested:');
  for (const [from, to] of [
    ['2024-04-01', '2024-07-31'],
    ['2023-04-01', '2023-12-31'],
  ] as const) {
    try {
      const response = await client.send(
        buildReportRequest('Cash Flow', {
          fromDate: from,
          toDate: to,
          format: config.tallyPreferredFormat,
        }),
        'report'
      );
      console.log(`  ${from} .. ${to}  ${String(monthRowCount(response.body)).padStart(3)} rows`);
    } catch (error) {
      console.log(`  ${from} .. ${to}   ERROR  ${(error as Error).message}`);
    }
    if (!(await healthy())) {
      console.error('\nTallyPrime stopped answering. ABORTING.');
      process.exitCode = 1;
      return;
    }
  }

  console.log(
    [
      '',
      'Reading this: if every "implied end" is the same month, accumulation ends at a',
      'FIXED point regardless of where it starts — and that point, not "the financial',
      "year end\", is what the warning must name. If the implied end tracks fromDate",
      'instead, the span is relative and the rule is different again. Either way the',
      'shipped wording is wrong and this table is what replaces it.',
    ].join('\n')
  );
}

await main();
