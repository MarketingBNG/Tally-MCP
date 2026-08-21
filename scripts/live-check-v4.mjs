/**
 * Live checks for the two changes made 2026-08-14, against whatever company
 * TallyPrime currently has open.
 *
 *   1. The end-date rule. `SVTODATE` binds only on a 31st, so a statement must
 *      report `coversPeriodRequested: true` for a period ending on one and
 *      `false` otherwise, with an accumulation end that is derived from the
 *      COMPANY'S OWN book year rather than an assumed 1 April.
 *   2. `tally_get_closing_stock`, both `by: 'item'` and `by: 'godown'`.
 *
 * Runs against `dist/`, the same build Claude Desktop launches, so a stale build
 * shows up here rather than in front of a user. Sequential throughout: Tally's
 * listener serves one request at a time.
 *
 * Assertions are about SHAPE and CONSISTENCY, never about specific figures — the
 * figures belong to whichever company is loaded and would make this a test of
 * one company's books. Nothing is printed that could carry a party name or a
 * balance.
 *
 *   node scripts/live-check-v4.mjs
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

// fileURLToPath plus pathToFileURL, not string concatenation: this repo's own
// path contains a space, and on Windows a bare absolute path is not a valid ESM
// specifier at all. The same hazard is documented in live-check.mjs.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const dist = async (rel) => {
  try {
    return await import(pathToFileURL(`${ROOT}/dist/${rel}`).href);
  } catch (error) {
    console.error(
      `\nCould not load dist/${rel}. Run "npm run build" first — this script deliberately\n` +
        'exercises the built output, because that is what Claude Desktop launches.\n'
    );
    throw error;
  }
};

const { loadConfig } = await dist('config/config.js');
const { createLogger } = await dist('utils/logger.js');
const { TallyClient } = await dist('tally/TallyClient.js');
const { buildCompanyListRequest, buildReportRequest } = await dist('tally/requests.js');
const { normalizeCompanies, normalizeClosingStock } = await dist('tally/normalize.js');
const { bookYearFor, endDateBinds, nearestBindingEndDate } = await dist('utils/dates.js');

const config = loadConfig({ ...process.env, TALLY_CACHE_TTL_MS: '0' });
const logger = createLogger('error');
const client = new TallyClient(config, logger);

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks++;
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`);
  }
}

async function main() {
  console.log(`Live check against ${config.tallyBaseUrl}\n`);

  let company;
  try {
    company = normalizeCompanies((await client.send(buildCompanyListRequest(), 'standard')).body)
      .data[0];
  } catch (error) {
    console.error(`Could not reach TallyPrime: ${error.message}`);
    console.error('Nothing was checked. Start TallyPrime, open a company, and re-run.');
    process.exitCode = 1;
    return;
  }

  if (company === undefined) {
    console.error('TallyPrime is running but has no company open. Nothing was checked.');
    process.exitCode = 1;
    return;
  }

  console.log(`Company: ${company.name}`);
  console.log(`Books:   ${company.startingFrom} to ${company.endingAt ?? '(no end reported)'}\n`);

  // -- 1. The company's own book year -------------------------------------
  console.log('Book year, derived from the company rather than assumed:');

  check('Tally reported a start date', company.startingFrom !== null);
  check(
    'Tally reported an end date (ENDINGAT)',
    company.endingAt !== null,
    'without it the accumulation end falls back to today, which is less accurate'
  );

  const year =
    company.startingFrom === null
      ? null
      : bookYearFor(company.startingFrom, company.endingAt ?? company.startingFrom);

  if (year !== null) {
    console.log(`  Book year: ${year.fromDate} to ${year.toDate}`);
    check('book year is not inverted', year.fromDate <= year.toDate);
    check(
      'book year contains the last date the company holds data for',
      company.endingAt === null ||
        (company.endingAt >= year.fromDate && company.endingAt <= year.toDate)
    );
    check(
      'book year starts on the same month and day the books do',
      year.fromDate.slice(5) === company.startingFrom.slice(5)
    );
  }

  // -- 2. The end-date rule, observed rather than assumed ------------------
  // Cash Flow returns one row per month, so the row count IS the covered span.
  console.log('\nEnd-date rule, re-observed on the loaded company:');

  const monthCount = (body) =>
    [
      ...body.matchAll(/<DSPPERIOD>([^<]*)<\/DSPPERIOD>/gi),
      ...body.matchAll(/"DSPPERIOD"\s*:\s*"([^"]*)"/gi),
    ].length;

  const from = year?.fromDate ?? company.startingFrom;
  const fetchMonths = async (toDate) => {
    const body = (
      await client.send(
        buildReportRequest('Cash Flow', {
          fromDate: from,
          toDate,
          format: config.tallyPreferredFormat,
          // Always named. An unscoped request is answered from whichever company
          // TallyPrime considers current, so an unscoped probe could measure one
          // company while reporting on another.
          company: company.name,
        }),
        'report'
      )
    ).body;
    return monthCount(body);
  };

  // A 31st three months in, and the 30th two months in. Both are inside the
  // book year, so a difference between them is the rule and not the data.
  const y = Number(from.slice(0, 4));
  const binding = `${y}-03-31`;
  const ignored = `${y}-06-30`;

  if (from.slice(5) === '01-01') {
    const boundRows = await fetchMonths(binding);
    const looseRows = await fetchMonths(ignored);
    console.log(`  toDate ${binding} (a 31st) -> ${boundRows} month rows`);
    console.log(`  toDate ${ignored} (a 30th) -> ${looseRows} month rows`);

    check(`endDateBinds() agrees that ${binding} binds`, endDateBinds(binding));
    check(`endDateBinds() agrees that ${ignored} does not`, !endDateBinds(ignored));
    check(
      'the 31st returned exactly the months requested',
      boundRows === 3,
      `expected 3, got ${boundRows}`
    );
    check(
      'the 30th returned MORE than requested, proving it was ignored',
      looseRows > 6,
      `expected more than 6, got ${looseRows} — if this is 6, the rule has changed and known-limitations.md is now wrong`
    );
  } else {
    console.log('  SKIPPED: this check is written for a January-start company.');
  }

  check(
    'a suggested replacement end date would itself bind',
    (() => {
      const suggestion = nearestBindingEndDate(ignored);
      return suggestion === null || endDateBinds(suggestion);
    })()
  );

  // -- 3. Closing stock, both reports -------------------------------------
  console.log('\nClosing stock:');

  for (const [by, reportId, kind] of [
    ['item', 'Stock Summary', 'stockItem'],
    ['godown', 'Godown Summary', 'godown'],
  ]) {
    const body = (
      await client.send(buildReportRequest(reportId, { company: company.name }), 'report')
    ).body;
    const { data, warnings } = normalizeClosingStock(body, reportId.toLowerCase(), kind, '?');

    console.log(`  ${reportId}: ${data.length} rows, ${warnings.length} warnings`);

    if (data.length === 0) {
      console.log(`    (empty — this company records nothing for ${reportId})`);
      continue;
    }

    check(`${by}: every row has a name`, data.every((row) => row.name.trim() !== ''));
    check(
      `${by}: at least one row carries a value`,
      data.some((row) => row.closingValue !== null)
    );
    check(
      `${by}: no value was salvaged from an unparseable string`,
      warnings.every((w) => /Could not read the amount/.test(w) === false) ||
        data.some((row) => row.closingValue === null),
      'a warning about an unreadable amount must come with a null, not a number'
    );
    check(
      `${by}: quantities keep their unit`,
      data
        .filter((row) => row.closingQuantity !== null)
        .every((row) => /[A-Za-z]/.test(row.closingQuantity)),
      'a quantity with no unit letter suggests the unit was lost'
    );

    // The rounded-rate trap, checked on real data rather than asserted from the
    // fixture: if quantity x rate happened to equal value everywhere, the
    // warning in the tool description would be over-cautious. It does not.
    const mismatched = data.filter((row) => {
      if (row.closingQuantity === null || row.closingRate === null || row.closingValue === null) {
        return false;
      }
      const qty = Number.parseFloat(row.closingQuantity.replace(/,/g, ''));
      const rate = Number.parseFloat(row.closingRate.replace(/,/g, ''));
      const value = Math.abs(Number.parseFloat(row.closingValue.amount));
      if (!Number.isFinite(qty) || !Number.isFinite(rate) || !Number.isFinite(value)) return false;
      return Math.abs(qty * rate - value) > 0.01;
    });
    if (mismatched.length > 0) {
      console.log(
        `    ${mismatched.length} of ${data.length} rows have quantity x rate != value — ` +
          'confirms the rate is rounded and must not be multiplied back.'
      );
    }
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) {
    console.log('TallyPrime answered throughout; the failures above are about this build.');
    process.exitCode = 1;
  }
}

await main();
