/**
 * Does the WIRE FORMAT of SVFROMDATE/SVTODATE change whether Tally honours them?
 *
 * Background. `known-limitations.md` records that a statement's end date binds
 * only when its day-of-month is the 31st — established by sweeping nineteen end
 * dates against a live company. That is a genuinely strange rule: 30 June and
 * 30 September are month ends too, and no Tally documentation describes any such
 * behaviour. A rule that odd is worth one more attempt at a simpler explanation
 * before a guard is built on top of it.
 *
 * The candidate explanation is the date literal itself. This server sends
 * `YYYYMMDD` (`20240630`), which Tally's own sample XML does use. But
 * `tally-database-loader` — the most heavily exercised Tally extractor in
 * production — sends `d-MMM-yyyy` (`30-Jun-2024`) instead. If Tally parses one
 * form reliably and the other only sometimes, then "binds on a 31st" is not a
 * report behaviour at all; it is a parsing artefact, and every mid-year
 * statement and period comparison this server currently refuses could be
 * answered exactly.
 *
 * So this holds the dates constant and varies only how they are WRITTEN, across
 * four encodings:
 *
 *   compact   <SVTODATE>20240630</SVTODATE>              — what this server sends today
 *   dmy       <SVTODATE>30-Jun-2024</SVTODATE>           — what tally-database-loader sends
 *   typed     <SVTODATE TYPE="Date">20240630</SVTODATE>  — the attribute several integrations add
 *   iso       <SVTODATE>2024-06-30</SVTODATE>            — control; expected to be the weakest
 *
 * It asserts nothing and concludes nothing. It prints the table a conclusion can
 * be drawn from.
 *
 * `Cash Flow` is the observable, for the same reason probe-todate-binding.ts
 * uses it: it returns ONE ROW PER MONTH, so the row count reads out directly
 * which span Tally chose. A balance report would total silently and reveal
 * nothing. The end dates are chosen to straddle the claimed rule — 30 June and
 * 30 September are the two the current rule says CANNOT work, and are the whole
 * point of the run; 31 July and 31 December are controls that should work under
 * either explanation.
 *
 * SAFETY: one verified report ID (`Cash Flow`, already in this server's
 * allowlist and used in production), one request at a time, cache off, with a
 * health probe between every call and an abort if Tally stops answering. No
 * unknown report IDs and no collections — only the date literal varies, which
 * is the narrowest possible change from a request shape known to be safe.
 *
 *   TALLY_PROBE_CONFIRM=yes npx tsx scripts/probe-date-format.ts
 */

import { loadConfig } from '../src/config/config.js';
import { createLogger } from '../src/utils/logger.js';
import { TallyClient } from '../src/tally/TallyClient.js';
import { buildCompanyListRequest, buildConnectionProbeRequest } from '../src/tally/requests.js';
import { normalizeCompanies } from '../src/tally/normalize.js';

/** The four ways of writing a date that this run compares. */
type Encoding = 'compact' | 'dmy' | 'typed' | 'iso';

const ENCODINGS: readonly Encoding[] = ['compact', 'dmy', 'typed', 'iso'];

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * Render an ISO date in one of the four encodings.
 *
 * Day is deliberately NOT zero-padded in `dmy`: `tally-database-loader` emits
 * `1-Apr-2024`, not `01-Apr-2024`, and the point of this run is to reproduce
 * what is known to work in production rather than a tidied-up version of it.
 */
function renderDate(iso: string, encoding: Encoding): { text: string; attribute: string } {
  const [year, month, day] = iso.split('-') as [string, string, string];
  const monthName = MONTHS[Number(month) - 1] ?? month;

  switch (encoding) {
    case 'compact':
      return { text: `${year}${month}${day}`, attribute: '' };
    case 'dmy':
      return { text: `${String(Number(day))}-${monthName}-${year}`, attribute: '' };
    case 'typed':
      return { text: `${year}${month}${day}`, attribute: ' TYPE="Date"' };
    case 'iso':
      return { text: iso, attribute: '' };
  }
}

/**
 * The Cash Flow request, with the date literal written per `encoding`.
 *
 * Built here rather than via `buildReportRequest` because that helper routes
 * every date through `isoToTallyDate`, which is precisely the thing under test.
 * The envelope is otherwise byte-for-byte the shape the server already sends,
 * and the report ID is fixed to a verified one — it is not a parameter.
 */
function cashFlowRequest(fromIso: string, toIso: string, encoding: Encoding): string {
  const from = renderDate(fromIso, encoding);
  const to = renderDate(toIso, encoding);

  return [
    '<ENVELOPE>',
    '<HEADER>',
    '<VERSION>1</VERSION>',
    '<TALLYREQUEST>Export</TALLYREQUEST>',
    '<TYPE>Data</TYPE>',
    '<ID>Cash Flow</ID>',
    '</HEADER>',
    '<BODY><DESC>',
    '<STATICVARIABLES>',
    '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>',
    `<SVFROMDATE${from.attribute}>${from.text}</SVFROMDATE>`,
    `<SVTODATE${to.attribute}>${to.text}</SVTODATE>`,
    '</STATICVARIABLES>',
    '</DESC></BODY>',
    '</ENVELOPE>',
  ].join('');
}

/**
 * Count month rows without parsing amounts.
 *
 * Structural marker only, for the same reason probe-todate-binding.ts does it
 * this way: a parser bug must not be able to hide inside this result. No figures
 * are printed — only counts and month labels, which are not company data.
 */
function monthRows(body: string): { count: number; first: string; last: string } {
  const names = [
    ...body.matchAll(/<DSPPERIOD>([^<]*)<\/DSPPERIOD>/gi),
    ...body.matchAll(/"DSPPERIOD"\s*:\s*"([^"]*)"/gi),
  ].map((match) => match[1] ?? '');

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
        '  TALLY_PROBE_CONFIRM=yes npx tsx scripts/probe-date-format.ts'
    );
    process.exitCode = 1;
    return;
  }

  // Cache OFF: with it on, the second encoding would be answered from the first
  // encoding's response and every row would agree for the wrong reason.
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
  console.log(`Books start: ${booksFrom ?? '(not reported)'}`);

  /**
   * Anchor the sweep on the company's own financial year rather than a
   * hard-coded Indian one — a calendar-year company was what contradicted the
   * original finding, so assuming April here would risk repeating that mistake.
   */
  const anchorYear = booksFrom === null ? 2024 : Number(booksFrom.slice(0, 4)) + 3;
  const monthDay = booksFrom === null ? '04-01' : booksFrom.slice(5);
  const from = `${String(anchorYear)}-${monthDay}`;

  /**
   * Six months out from the start, and twelve. Under "the end date is ignored"
   * both return the same count. Under "it binds" they differ, and the two
   * non-31st dates are the ones the current rule says must fail.
   */
  const toDates = [
    `${String(anchorYear)}-06-30`,
    `${String(anchorYear)}-07-31`,
    `${String(anchorYear)}-09-30`,
    `${String(anchorYear)}-12-31`,
  ];

  console.log(`fromDate held at ${from}\n`);

  for (const encoding of ENCODINGS) {
    const sample = renderDate(toDates[0] ?? from, encoding);
    console.log(`${encoding.padEnd(8)} (e.g. <SVTODATE${sample.attribute}>${sample.text}</...>)`);
    console.log('  toDate        rows  first -> last');

    for (const to of toDates) {
      try {
        const response = await client.send(cashFlowRequest(from, to, encoding), 'report');
        const { count, first, last } = monthRows(response.body);
        console.log(`  ${to}  ${String(count).padStart(4)}  ${first} -> ${last}`);
      } catch (error) {
        console.log(`  ${to}   ERROR  ${(error as Error).message}`);
      }

      if (!(await healthy())) {
        console.error('\nTallyPrime stopped answering. ABORTING — nothing further will be sent.');
        process.exitCode = 1;
        return;
      }
    }
    console.log('');
  }

  console.log(
    [
      'Reading this:',
      '  - If every encoding gives the same counts, the date literal is NOT the explanation',
      '    and the 31st rule stands as a real report behaviour. The existing guard is correct.',
      '  - If any encoding makes 30 June or 30 September track the requested end date where',
      '    "compact" does not, then the 31st rule is a parsing artefact of the current wire',
      '    format, and mid-year statements and comparisons can be answered exactly.',
      '  - A count of 0 on a row means the request was rejected or returned nothing at all,',
      '    which is a different finding from a wrong span and must not be read as one.',
    ].join('\n')
  );
}

await main();
