
import {
  DEFAULT_CURRENCY,
  type Money,
} from '../../utils/numbers.js';

import {
  findFirst,
  pairReportRows,
  textOf,
  type PairedRow,
} from '../TallyResponseParser.js';
import {
  descendantScalars,
  openDocument,
  readMoney,
  reportContainer,
  sourceRef,
  unreadablePayloadWarning,
  type Normalized,
  type SourceRef,
  EMPTY_ENVELOPE_BYTES,
} from './shared.js';

/**
 * Reports: closing stock, trial balance, monthly flow, the balance sheet and
 * P&L statements, and the allowlisted generic report.
 *
 * Split out of the single normalize.ts, which had grown to 1,461 lines across
 * thirteen banner-delimited sections. Every function here follows the same two
 * rules as the rest of the normalisers.
 *
 * **Sign is preserved, never corrected.** Tally's trial balance reports debit
 * balances as negative and P&L expenses as negative. That is Tally's own
 * encoding, and silently flipping it would mean the number Claude reasons about
 * is not the number the accountant would see in Tally.
 *
 * **An unreadable value becomes null plus a warning, never a zero.** A
 * fabricated 0.00 in an audit context is worse than an admitted gap, because it
 * is indistinguishable from a real balance of zero.
 */

/**
 * Every TallyPrime element name this module depends on, in one place.
 *
 * These are the wire contract, and TallyPrime does not document it. Scattered as
 * bare literals through the normalisers they were unreviewable: a tag renamed or
 * dropped in a future Tally build yields ZERO ROWS, not a type error, and the
 * only way to find what a normaliser actually requires was to read every line of
 * it. Collected here, "what does this module need from Tally?" is one block to
 * read and one place to change.
 *
 * The keys are the tag names themselves rather than friendlier aliases: an alias
 * would put a second vocabulary between the reader and the payload they are
 * comparing against, and the payload only ever says the tag.
 */
const TAG = {
  DSPACCINFO: 'DSPACCINFO',
  DSPACCNAME: 'DSPACCNAME',
  DSPCLAMTA: 'DSPCLAMTA',
  DSPCRAMTA: 'DSPCRAMTA',
  DSPDRAMTA: 'DSPDRAMTA',
  DSPPERIOD: 'DSPPERIOD',
  DSPSTKCL: 'DSPSTKCL',
  DSPSTKINFO: 'DSPSTKINFO',
  RATIONAME: 'RATIONAME',
  RATIOVALUE: 'RATIOVALUE',
} as const;

export interface ClosingStockRow {
  /** Stock item name, or godown name, depending on which report was fetched. */
  name: string;
  /**
   * Closing quantity exactly as Tally formats it, unit included — "9500.00 Kg".
   *
   * Kept as ONE STRING rather than split into a number and a unit, which is the
   * convention `StockItem` above already follows. A bare stock number is
   * meaningless and worse than absent: `toMoney` deliberately refuses strings
   * like this because the salvage attempt used to return figures 100x too large.
   */
  closingQuantity: string | null;
  /**
   * Closing rate exactly as Tally formats it.
   *
   * ROUNDED, and therefore not a basis for arithmetic. Verified live 2026-08-14:
   * an item with quantity 9500.00 Kg and rate 4.85 carried a Tally value of
   * -46,084.41, where 9500 x 4.85 is 46,075.00 — the true rate is 4.8510958 and
   * the report shows two decimals. Multiplying quantity by rate produces a
   * figure that looks right and is not. Use `closingValue`, which is Tally's own.
   */
  closingRate: string | null;
  /**
   * Tally's own closing value. NEGATIVE on stock in hand, matching the debit
   * convention everywhere else in this server. Sign preserved, never corrected.
   */
  closingValue: Money | null;
  source: SourceRef;
}

/**
 * Both `Stock Summary` and `Godown Summary` share one wire shape, verified live
 * 2026-08-14 on the company that finally populated them:
 *
 *   DSPACCNAME > DSPDISPNAME            (item name, or godown name)
 *   DSPSTKINFO > DSPSTKCL > DSPCLQTY / DSPCLRATE / DSPCLAMTA
 *
 * The two alternate as siblings directly under `<ENVELOPE>` with no `<DATA>`
 * wrapper, which is the same positional pairing the trial balance uses — so it
 * goes through `pairReportRows` rather than a zip of two filtered lists, for the
 * reason documented there: a heading or subtotal row missing one side would
 * otherwise shift every subsequent pairing silently.
 *
 * `entityKind` only picks the source entity type and the wording of warnings.
 * The parsing is identical because the reports are identical in shape.
 */
export function normalizeClosingStock(
  xml: string,
  reportName: string,
  entityKind: 'stockItem' | 'godown',
  currency: string = DEFAULT_CURRENCY
): Normalized<ClosingStockRow[]> {
  const warnings: string[] = [];
  const container = reportContainer(openDocument(xml));
  const rows = pairReportRows(container, TAG.DSPACCNAME, TAG.DSPSTKINFO);

  const data = rows.map((row) => {
    const closing = row.value === null ? null : findFirst([row.value], TAG.DSPSTKCL);
    const read = (tag: string): string | null => {
      if (closing === null) return null;
      const node = findFirst([closing], tag);
      return node === null ? null : textOf(node);
    };

    noteMissingValue(row, reportName, warnings);

    return {
      name: row.name,
      closingQuantity: read('DSPCLQTY'),
      closingRate: read('DSPCLRATE'),
      closingValue: readMoney(
        read('DSPCLAMTA'),
        `closing value of "${row.name}"`,
        warnings,
        currency
      ),
      source: sourceRef(entityKind, row.name),
    };
  });

  // A payload that carried content must never read as an empty result.
  const unread = unreadablePayloadWarning(xml, data.length, 'the closing stock report');
  if (unread !== undefined) warnings.push(unread);

  return { data, warnings };
}

export interface TrialBalanceRow {
  name: string;
  /**
   * Closing debit and credit columns. Tally reports the debit column as a
   * negative number; that is preserved. Null means the column was empty.
   */
  debit: Money | null;
  credit: Money | null;
}

/**
 * One paired-row report, read into name plus two amount columns.
 *
 * Every report Tally serves in the parallel-sibling shape — trial balance,
 * balance sheet, P&L — is the same read: pair the name array against the amount
 * array, pull two tagged amounts out of each pair, note the rows that arrived
 * without an amount block, and refuse to report an unreadable payload as an
 * empty result. `normalizeTrialBalance` and `normalizeStatement` each carried
 * their own copy of it, differing only in which tags to read, what to call the
 * figures in a warning, and what to name the two columns in the output.
 *
 * The column NAMES stay with the callers rather than being parameterised too. A
 * trial balance has a debit and a credit column, which are different things; a
 * statement has an amount and a sub-total, which are also different things. One
 * generic pair of keys would make both outputs describe themselves less
 * accurately than they do now, and the output shape is what tools and tests
 * read.
 */
function readPairedReport(
  xml: string,
  spec: {
    nameTag: string;
    valueTag: string;
    /** Read first, so warnings appear in column order. */
    firstTag: string;
    secondTag: string;
    firstLabel: (name: string) => string;
    secondLabel: (name: string) => string;
    /** How the report is named when a row has no amount block. */
    reportName: string;
    /** How it is named when the whole payload could not be read. */
    payloadName: string;
    currency: string;
  }
): { rows: { name: string; first: Money | null; second: Money | null }[]; warnings: string[] } {
  const warnings: string[] = [];
  const container = reportContainer(openDocument(xml));
  const paired = pairReportRows(container, spec.nameTag, spec.valueTag);

  const rows = paired.map((row) => {
    const firstNode = row.value === null ? null : findFirst([row.value], spec.firstTag);
    const secondNode = row.value === null ? null : findFirst([row.value], spec.secondTag);

    noteMissingValue(row, spec.reportName, warnings);

    return {
      name: row.name,
      first: readMoney(
        firstNode === null ? null : textOf(firstNode),
        spec.firstLabel(row.name),
        warnings,
        spec.currency
      ),
      second: readMoney(
        secondNode === null ? null : textOf(secondNode),
        spec.secondLabel(row.name),
        warnings,
        spec.currency
      ),
    };
  });

  // A payload that carried content must never read as an empty result.
  const unread = unreadablePayloadWarning(xml, rows.length, spec.payloadName);
  if (unread !== undefined) warnings.push(unread);

  return { rows, warnings };
}

export function normalizeTrialBalance(
  xml: string,
  currency: string = DEFAULT_CURRENCY
): Normalized<TrialBalanceRow[]> {
  const { rows, warnings } = readPairedReport(xml, {
    nameTag: 'DSPACCNAME',
    valueTag: 'DSPACCINFO',
    firstTag: 'DSPCLDRAMTA',
    secondTag: 'DSPCLCRAMTA',
    firstLabel: (name) => `debit of "${name}"`,
    secondLabel: (name) => `credit of "${name}"`,
    reportName: 'trial balance',
    payloadName: 'the trial balance',
    currency,
  });

  const data = rows.map((row) => ({ name: row.name, debit: row.first, credit: row.second }));
  return { data, warnings };
}

/** Report a name that arrived with no matching amount block. */
function noteMissingValue(row: PairedRow, reportName: string, warnings: string[]): void {
  if (row.value === null) {
    warnings.push(
      `The ${reportName} row "${row.name}" arrived with no amount block; its figures are reported as null.`
    );
  }
}

export interface MonthlyFlowRow {
  /** Month name exactly as Tally labels it, e.g. "April". No year is sent. */
  period: string;
  /** Tally's debit column. Sign preserved: debits arrive negative. */
  debit: Money | null;
  credit: Money | null;
  /**
   * Tally's own net column, passed through rather than recomputed. Observed
   * live: debit + credit on the cash flow report; credit − debit on the funds
   * flow report, where debit and credit are the month's opening and closing
   * funds.
   */
  net: Money | null;
}

/**
 * Both flow reports share one wire shape: DSPPERIOD (a month name) and
 * DSPACCINFO alternate as siblings, the same positional pairing the trial
 * balance uses, with three amounts nested inside each info block.
 */
export function normalizeMonthlyFlow(
  xml: string,
  reportName: string,
  currency: string = DEFAULT_CURRENCY
): Normalized<MonthlyFlowRow[]> {
  const warnings: string[] = [];
  const container = reportContainer(openDocument(xml));
  const rows = pairReportRows(container, TAG.DSPPERIOD, TAG.DSPACCINFO);

  const data = rows.map((row) => {
    const debitNode = row.value === null ? null : findFirst([row.value], TAG.DSPDRAMTA);
    const creditNode = row.value === null ? null : findFirst([row.value], TAG.DSPCRAMTA);
    const netNode = row.value === null ? null : findFirst([row.value], TAG.DSPCLAMTA);

    noteMissingValue(row, reportName, warnings);

    return {
      period: row.name,
      debit: readMoney(
        debitNode === null ? null : textOf(debitNode),
        `debit of "${row.name}"`,
        warnings,
        currency
      ),
      credit: readMoney(
        creditNode === null ? null : textOf(creditNode),
        `credit of "${row.name}"`,
        warnings,
        currency
      ),
      net: readMoney(
        netNode === null ? null : textOf(netNode),
        `net of "${row.name}"`,
        warnings,
        currency
      ),
    };
  });

  // A payload that carried content must never read as an empty result.
  const unread = unreadablePayloadWarning(xml, data.length, 'this monthly flow report');
  if (unread !== undefined) warnings.push(unread);

  return { data, warnings };
}

export interface StatementRow {
  name: string;
  /**
   * The main column. Tally's sign convention is preserved: liabilities and
   * income arrive positive, assets and expenses negative.
   */
  amount: Money | null;
  /** The indented sub-total column, populated only on some rows. */
  subAmount: Money | null;
}

export function normalizeBalanceSheet(
  xml: string,
  currency: string = DEFAULT_CURRENCY
): Normalized<StatementRow[]> {
  return normalizeStatement(
    xml,
    'BSNAME',
    'BSAMT',
    'BSSUBAMT',
    'BSMAINAMT',
    'balance sheet',
    currency
  );
}

/**
 * Profit and loss.
 *
 * Note the tag mix: the value block is `PLAMT`, but the main column inside it
 * is `BSMAINAMT` — Tally reuses the balance sheet tag rather than defining a
 * P&L-specific one. Verified against a live export; not a copy-paste slip.
 */
export function normalizeProfitLoss(
  xml: string,
  currency: string = DEFAULT_CURRENCY
): Normalized<StatementRow[]> {
  return normalizeStatement(
    xml,
    'DSPACCNAME',
    'PLAMT',
    'PLSUBAMT',
    'BSMAINAMT',
    'profit and loss',
    currency
  );
}

function normalizeStatement(
  xml: string,
  nameTag: string,
  valueTag: string,
  subAmountTag: string,
  mainAmountTag: string,
  reportName: string,
  currency: string
): Normalized<StatementRow[]> {
  const { rows, warnings } = readPairedReport(xml, {
    nameTag,
    valueTag,
    firstTag: mainAmountTag,
    secondTag: subAmountTag,
    firstLabel: (name) => `"${name}"`,
    secondLabel: (name) => `sub-total of "${name}"`,
    reportName,
    payloadName: 'this statement',
    currency,
  });

  const data = rows.map((row) => ({ name: row.name, amount: row.first, subAmount: row.second }));
  return { data, warnings };
}

/**
 * One row of a report whose exact shape is not known in advance.
 *
 * `amounts` holds every scalar under the value block under TallyPrime's own tag
 * names — `DSPCLDRAMTA`, `DSPCLCRAMTA`, and whatever else the particular report
 * emits — rather than being renamed to debit/credit. Renaming would mean
 * asserting which column is which on a report whose columns have not been
 * verified, and getting that wrong silently is the failure this whole file is
 * written to avoid. A caller reading `DSPCLDRAMTA` knows exactly what it has.
 */
export interface GenericReportRow {
  name: string;
  amounts: Record<string, string>;
}

/**
 * Parse a report into name/amount rows without knowing its column meanings.
 *
 * Every TallyPrime report observed so far uses the same positional pairing the
 * trial balance does: a name node and an info node alternating as siblings. So
 * this reads the shape rather than the report, which is what makes one function
 * serve an allowlist of views whose individual layouts differ.
 *
 * When the pairing finds nothing, the result is an EMPTY row list plus a
 * warning — never an error and never an invented row. Tally answers a valid
 * report that has nothing to show with a 23-byte empty envelope, and that is a
 * real answer ("no negative ledgers") which must not be reported as a failure.
 */
export function normalizeGenericReport(
  xml: string,
  reportName: string
): Normalized<GenericReportRow[]> {
  const warnings: string[] = [];
  const container = reportContainer(openDocument(xml));

  /*
   * THREE ROW SHAPES, not one — and reading only the first is silent data loss.
   *
   * This function used to pair `DSPACCNAME` with `DSPACCINFO` and nothing else.
   * That is the shape `Negative Ledgers` uses, and it was the report the
   * allowlist was verified against, so the code looked right.
   *
   * Measured live 2026-08-17 against MUDALS TECHNOLOGIES (284 vouchers, 155 of
   * them journals), the other reports do NOT use it:
   *   - `Journal Register`  2,098 bytes of DSPPERIOD / DSPACCINFO
   *   - `Sales Register`    2,817 bytes of the same
   *   - `Ratio Analysis`    1,677 bytes of RATIONAME / RATIOVALUE
   * Every one of those parsed to ZERO rows. TallyPrime sent real figures and
   * this server reported "no rows" — then appended the note below explaining
   * that an empty result is a real answer on an exception report. So the output
   * did not merely lose the data, it argued that the loss was a clean result.
   * On a register that reads as "this company records no sales".
   *
   * The shapes are tried in order and the first that yields rows wins. They are
   * mutually exclusive in practice — a report emits one vocabulary — so this
   * cannot mix two together. A report matching none still returns no rows, but
   * now says so as an unrecognised LAYOUT rather than as an empty report, which
   * is a different claim and the honest one.
   */
  let layout = 'DSPACCNAME/DSPACCINFO';
  let rows = pairReportRows(container, TAG.DSPACCNAME, TAG.DSPACCINFO);

  if (rows.length === 0) {
    // Register reports: one row per PERIOD rather than per account.
    const byPeriod = pairReportRows(container, TAG.DSPPERIOD, TAG.DSPACCINFO);
    if (byPeriod.length > 0) {
      layout = 'DSPPERIOD/DSPACCINFO';
      rows = byPeriod;
    }
  }

  if (rows.length === 0) {
    // Ratio Analysis: flat name/value pairs, no amount block at all.
    const ratios = pairReportRows(container, TAG.RATIONAME, TAG.RATIOVALUE);
    if (ratios.length > 0) {
      layout = 'RATIONAME/RATIOVALUE';
      rows = ratios;
    }
  }

  const data: GenericReportRow[] = [];
  for (const row of rows) {
    // Amounts nest one level deeper than the info block on every report
    // observed, so a shallow scalar read would come back empty. The descendant
    // walk finds them wherever the particular report puts them.
    //
    // RATIOVALUE is a scalar rather than a block, so it has no descendants to
    // walk; its own text IS the value and is reported under its own tag name,
    // keeping the "columns are TallyPrime's tag names" contract intact.
    const amounts =
      row.value === null
        ? {}
        : layout === 'RATIONAME/RATIOVALUE'
          ? { RATIOVALUE: (textOf(row.value) ?? '').trim() }
          : descendantScalars(row.value);

    if (row.value === null) {
      warnings.push(
        `The "${reportName}" row "${row.name}" arrived with no amount block; it is reported with ` +
          'no amounts rather than with zeros.'
      );
    }
    data.push({ name: row.name, amounts });
  }

  if (data.length > 0 && layout !== 'DSPACCNAME/DSPACCINFO') {
    warnings.push(
      `"${reportName}" uses TallyPrime's ${layout} row layout rather than the per-account one. ` +
        (layout === 'DSPPERIOD/DSPACCINFO'
          ? 'Each row is a PERIOD (a month), not an account, so the "name" is a date range and ' +
            'the figures are that period\'s totals. Do not read these rows as ledger balances.'
          : 'Each row is a named ratio and its value, so there are no debit/credit columns to ' +
            'read; the value is reported under TallyPrime\'s own RATIOVALUE tag.')
    );
  }

  if (data.length === 0) {
    // Distinguish "Tally sent nothing" from "Tally sent something this parser
    // does not recognise". Reporting the second as the first is what produced
    // the silent loss described above, and the byte count is the evidence.
    const bytes = xml.length;
    const looksPopulated = bytes > EMPTY_ENVELOPE_BYTES;
    warnings.push(
      looksPopulated
        ? `UNRECOGNISED ROW LAYOUT: TallyPrime returned ${String(bytes)} bytes for ` +
          `"${reportName}", so it is NOT an empty report — but none of the row layouts this ` +
          'server knows (DSPACCNAME/DSPACCINFO, DSPPERIOD/DSPACCINFO, RATIONAME/RATIOVALUE) ' +
          'matched it, so no rows could be read. Do NOT report this as "nothing to report": ' +
          'there is data here that this server could not parse. Open the report in TallyPrime ' +
          'to read it, and treat this as a gap in this server rather than in the books.'
        : `TallyPrime accepted "${reportName}" and returned no rows. On this report that is a ` +
          'real answer, not a failure — but it is also what an unpopulated feature looks like, ' +
          'so check whether this company uses the feature before reading it as "nothing to ' +
          'report".'
    );
  }

  return { data, warnings };
}
