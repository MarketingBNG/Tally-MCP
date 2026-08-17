import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  companySchema,
  dateRangeSchema,
  paginationSchema,
  PERIOD_NOTE,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import { FIELD_HEAVY_PAGE_SIZE, paginate, resolvePagination } from '../utils/pagination.js';
import {
  assertResultSetFits,
  fromPage,
  resolvePeriodForCompany,
  runTool,
  whole,
  type ToolBodyResult,
  type ToolDeps,
} from './toolResult.js';
import { fetchLedgers } from './ledgers.js';
import { fetchVouchers } from './vouchers.js';

/**
 * TDS and TCS tools.
 *
 * ## Retrieved, never calculated
 *
 * The same rule as the GST tools, and for a sharper reason. A TDS figure
 * depends on the nature of payment, the section, the deductee's PAN status
 * (206AA doubles the rate where PAN is absent), lower-deduction certificates
 * under 197, threshold limits that apply per payee per year, and whether the
 * payee is an individual or a company. Every one of those is either outside
 * Tally or outside what this server can verify.
 *
 * So nothing here computes a liability, a shortfall, or a 40(a)(ia)
 * disallowance. What it does is answer the question that IS answerable from
 * the books: which ledgers are configured for TDS, which are not, and what
 * Tally actually recorded against them. That is the starting point of the
 * procedure, and it is where the audit value is — a payment ledger that should
 * be flagged for TDS and is not is a control finding regardless of the rate.
 *
 * ## What was verified, and what was not
 *
 * The applicability flags are real ledger master fields, confirmed live
 * 2026-08-17 against MUDALS TECHNOLOGIES PRIVATE LIMITED: `ISTDSAPPLICABLE`,
 * `ISTCSAPPLICABLE`, `ISTDSEXPENSE`, `IGNORETDSEXEMPT`,
 * `TDSDEDUCTEEISSPECIALRATE` and `TDSDEDUCTEESPECIALRATE` were all present on
 * a ledger with TDS switched off, carrying explicit negatives.
 *
 * NOT verified: the section / nature-of-payment master. That is a separate
 * Tally master type, and no company probed so far has TDS enabled, so there is
 * no live evidence of what it looks like on the wire. This tool therefore
 * reports section-like fields verbatim WHERE THEY APPEAR and never claims a
 * section-wise breakdown is complete. Probing the master type directly is
 * ruled out under the collection-TYPE safety rule.
 */

const NO_CALCULATION_NOTICE =
  'NOTHING IS CALCULATED. This returns TDS/TCS configuration and recorded data exactly as ' +
  'TallyPrime holds it. No rate is applied, no shortfall computed, no 40(a)(ia) disallowance ' +
  'derived. Those depend on the section, the nature of payment, the deductee PAN status ' +
  '(206AA), lower-deduction certificates under 197 and per-payee annual thresholds — none of ' +
  'which this server can verify. If asked for a TDS liability or a short-deduction figure, ' +
  'report what Tally recorded, state that computing it is out of scope, and say which of the ' +
  'above inputs would be needed.';

const NOT_CONFIGURED_NOTICE =
  'IF EMPTY: a company that does not deduct tax at source returns nothing here, and that is a ' +
  'real answer rather than a failure. It is also the answer for any company outside India, ' +
  'where these fields exist in the master but are never switched on.';

const SECTION_CAVEAT =
  'SECTIONS ARE NOT GUARANTEED COMPLETE. Tally keeps the nature of payment and its section in a ' +
  'separate master that this server has never observed populated on live data. Section-like ' +
  'fields are passed through where they appear on a ledger or voucher, but their absence is NOT ' +
  'evidence that no section was assigned. Never present a section-wise summary from this tool as ' +
  'the complete picture — confirm against Tally screen or the TDS returns.';

const viewSchema = z
  .enum(['summary', 'transactions'])
  .describe(
    'summary: which ledgers are configured for TDS/TCS and how, no period needed. ' +
      'transactions: individual vouchers carrying TDS/TCS detail in a period.'
  );

const DESCRIPTION = [
  'TDS and TCS as TallyPrime records it, picked by `view` — one call, one view.',
  '',
  'summary: the TDS/TCS configuration across the chart of accounts. WHEN TO USE: as the first ' +
    'TDS call, and as a control test in its own right — the useful finding is usually a ledger ' +
    'that SHOULD carry a TDS flag and does not. RETURNS: the tax ledgers holding TDS/TCS, the ' +
    'party ledgers marked as deductees, the expense ledgers flagged as TDS-bearing, any ledger ' +
    'set to a special (206AA) rate, and any ledger set to ignore the exemption limit. Counts are ' +
    'given alongside, so "3 of 330" is visible rather than just the three. Needs no period.',
  '',
  'transactions: individual vouchers carrying TDS/TCS detail in a period, with the fields ' +
    'TallyPrime recorded on each. WHEN TO USE: to examine how tax was deducted on specific ' +
    'payments as entered rather than as computed. RETURNS: one row per voucher with any TDS/TCS ' +
    'field or structure, carrying the voucher identity plus those fields verbatim under ' +
    "TallyPrime's own field names. DERIVED FROM: the voucher register for the period. Requires " +
    'fromDate/toDate (or accepts the default financial-year period).',
  '',
  NO_CALCULATION_NOTICE,
  '',
  SECTION_CAVEAT,
  '',
  NOT_CONFIGURED_NOTICE,
  '',
  PERIOD_NOTE,
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

/** Tally group names for tax ledgers. Overridable, since companies rename groups. */
const DEFAULT_TAX_GROUPS = ['Duties & Taxes'];

/**
 * Field-name fragments that mark TDS/TCS content.
 *
 * Tally field names are concatenated upper-case words with no separators, so
 * every hint here has been checked against the ~90 real field names observed on
 * a live ledger master for accidental substring collisions. `TDS` and `TCS` are
 * distinctive enough to be safe; `DEDUCT` catches `TDSDEDUCTEE*` and the
 * deduction-detail structures without matching anything else observed.
 *
 * `NATUREOFPAYMENT` and `SECTION` are included because they are what a reviewer
 * actually wants — but see SECTION_CAVEAT: matching them is not the same as
 * their being present.
 */
const TDS_FIELD_HINTS = ['TDS', 'TCS', 'DEDUCT', 'NATUREOFPAYMENT', 'SECTION'];

/**
 * Keys that contain a hint as a coincidence of spelling.
 *
 * Kept as an explicit denylist for the same reason gst.ts keeps one: substring
 * matching over concatenated upper-case names is inherently approximate, and
 * the honest response is a named escape hatch rather than a cleverer regex.
 * `SORTPOSITION` and `SECTIONNAME`-style collisions belong here as they are
 * found against real data.
 */
const FALSE_POSITIVE_KEYS = new Set(['CROSSSECTION']);

/** Nested structures Tally uses for TDS detail. */
const TDS_STRUCTURE_HINTS = ['TDS', 'TCS', 'DEDUCT', 'NATUREOFPAYMENT'];

/**
 * Values that carry no information even on a TDS field.
 *
 * This matters more here than for GST. Tally stamps `ISTDSAPPLICABLE: "No"` and
 * `TDSDEDUCTEESPECIALRATE: "0"` onto every ledger in the company, including
 * companies that have never deducted tax in their lives. Treating presence as
 * evidence would report all 330 ledgers as TDS-configured.
 */
const UNINFORMATIVE_VALUES = new Set(['', 'not applicable', 'no', '0', '0.00', 'unknown']);

function isTdsKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (FALSE_POSITIVE_KEYS.has(upper)) return false;
  return TDS_FIELD_HINTS.some((hint) => upper.includes(hint));
}

function isInformative(value: string | undefined): boolean {
  if (value === undefined) return false;
  return !UNINFORMATIVE_VALUES.has(value.trim().toLowerCase());
}

/** A TDS field that says something about THIS record. */
function isInformativeTdsEntry([key, value]: [string, string]): boolean {
  return isTdsKey(key) && isInformative(value);
}

export function registerTdsTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_get_tds',
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        view: viewSchema,
        taxGroups: z
          .array(z.string().min(1))
          .optional()
          .describe(
            `summary only. Groups holding tax ledgers. Defaults to ${DEFAULT_TAX_GROUPS.map((g) => `"${g}"`).join(', ')}. Override if this company uses different group names.`
          ),
        company: companySchema,
        ...dateRangeSchema,
        ...paginationSchema,
      }),
    },
    async (args) =>
      runTool('tally_get_tds', deps, async () => {
        if (args.view === 'summary') return fetchTdsSummary(deps, args);
        return fetchTdsTransactions(deps, args);
      })
  );
}

/** One ledger's TDS configuration, reduced to what a reviewer would ask about. */
interface ConfiguredLedger {
  name: string;
  group: string | null;
  closingBalance: unknown;
  tdsFields: Record<string, string>;
  source: unknown;
}

function asConfigured(ledger: {
  name: string;
  parent: string | null;
  closingBalance: unknown;
  fields?: Record<string, string> | undefined;
  source: unknown;
}): ConfiguredLedger {
  return {
    name: ledger.name,
    group: ledger.parent,
    closingBalance: ledger.closingBalance,
    tdsFields: Object.fromEntries(Object.entries(ledger.fields ?? {}).filter(isInformativeTdsEntry)),
    source: ledger.source,
  };
}

async function fetchTdsSummary(
  deps: ToolDeps,
  args: { taxGroups?: string[] | undefined; company?: string | undefined }
): Promise<ToolBodyResult> {
  const groups = args.taxGroups ?? [...DEFAULT_TAX_GROUPS];
  const groupSet = new Set(groups.map((group) => group.toLowerCase()));

  // Full fields: none of the TDS flags are in the curated set.
  const { ledgers, warnings } = await fetchLedgers(deps, args.company, true);

  const flaggedYes = (ledger: { fields?: Record<string, string> | undefined }, field: string) =>
    isInformative(ledger.fields?.[field]);

  // Tax ledgers holding TDS/TCS. Matched on TAXTYPE first — Tally's own
  // classification — and on the ledger name only as a fallback, because a
  // company that renames "TDS Payable" to something else still classifies it.
  const taxLedgers = ledgers
    .filter((ledger) => groupSet.has((ledger.parent ?? '').toLowerCase()))
    .filter((ledger) => {
      const taxType = (ledger.fields?.TAXTYPE ?? '').toUpperCase();
      return taxType.includes('TDS') || taxType.includes('TCS') || isTdsKey(ledger.name);
    })
    .map(asConfigured);

  const deducteeLedgers = ledgers.filter((l) => flaggedYes(l, 'ISTDSAPPLICABLE')).map(asConfigured);
  const tcsLedgers = ledgers.filter((l) => flaggedYes(l, 'ISTCSAPPLICABLE')).map(asConfigured);
  const expenseLedgers = ledgers.filter((l) => flaggedYes(l, 'ISTDSEXPENSE')).map(asConfigured);

  // Two settings that a reviewer should always see, because each one overrides
  // a protection rather than merely enabling a feature.
  const specialRateLedgers = ledgers
    .filter((l) => flaggedYes(l, 'TDSDEDUCTEEISSPECIALRATE'))
    .map(asConfigured);
  const ignoringExemptionLimit = ledgers
    .filter((l) => flaggedYes(l, 'IGNORETDSEXEMPT'))
    .map(asConfigured);

  const allWarnings = [...warnings];
  const anyConfigured =
    taxLedgers.length +
      deducteeLedgers.length +
      tcsLedgers.length +
      expenseLedgers.length +
      specialRateLedgers.length +
      ignoringExemptionLimit.length >
    0;

  if (!anyConfigured) {
    allWarnings.push(
      `No ledger among ${String(ledgers.length)} carries any TDS or TCS setting. Tally stamps ` +
        'these fields onto every ledger with explicit negatives, so this is a positive finding ' +
        'that the feature is unused, not a failure to read it. For an Indian company with ' +
        'payments that attract TDS, that is itself the audit point.'
    );
  }
  if (specialRateLedgers.length > 0) {
    allWarnings.push(
      `${String(specialRateLedgers.length)} ledger(s) are set to a SPECIAL deduction rate. In ` +
        'Tally this is normally how the higher no-PAN rate under 206AA is applied. Check each ' +
        "against the deductee's PAN status — the flag records a decision, not its correctness."
    );
  }
  if (ignoringExemptionLimit.length > 0) {
    allWarnings.push(
      `${String(ignoringExemptionLimit.length)} ledger(s) are set to IGNORE the TDS exemption ` +
        'limit, which suppresses the threshold check. Deliberate for a payee already over the ' +
        'limit; a deduction error waiting to happen if it was set by accident.'
    );
  }

  return whole(
    {
      view: 'summary',
      taxGroupsUsed: groups,
      ledgersExamined: ledgers.length,
      taxLedgers,
      deducteeLedgers,
      tcsLedgers,
      expenseLedgers,
      specialRateLedgers,
      ignoringExemptionLimit,
      counts: {
        taxLedgers: taxLedgers.length,
        deducteeLedgers: deducteeLedgers.length,
        tcsLedgers: tcsLedgers.length,
        expenseLedgers: expenseLedgers.length,
        specialRateLedgers: specialRateLedgers.length,
        ignoringExemptionLimit: ignoringExemptionLimit.length,
      },
      ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
    },
    taxLedgers.length + deducteeLedgers.length + expenseLedgers.length
  );
}

async function fetchTdsTransactions(
  deps: ToolDeps,
  args: {
    company?: string | undefined;
    fromDate?: string | undefined;
    toDate?: string | undefined;
    page?: number | undefined;
    pageSize?: number | undefined;
  }
): Promise<ToolBodyResult> {
  const pagination = resolvePagination(args.page, args.pageSize, FIELD_HEAVY_PAGE_SIZE);
  const period = await resolvePeriodForCompany(deps, args.fromDate, args.toDate, args.company);

  // TDS detail lives in fields and nested structures, so full detail is needed.
  const { vouchers, warnings } = await fetchVouchers(deps, args.company, period, true);

  const rows = vouchers
    .map((voucher) => {
      const tdsFields = Object.fromEntries(
        Object.entries(voucher.fields ?? {}).filter(isInformativeTdsEntry)
      );

      const tdsStructures = Object.fromEntries(
        Object.entries(voucher.nested ?? {}).filter(([key]) =>
          TDS_STRUCTURE_HINTS.some((hint) => key.toUpperCase().includes(hint))
        )
      );

      const entryTds = voucher.entries
        .map((entry) => {
          const fields = Object.fromEntries(
            Object.entries(entry.fields ?? {}).filter(isInformativeTdsEntry)
          );
          const nested = Object.fromEntries(
            Object.entries(entry.nested ?? {}).filter(([key]) =>
              TDS_STRUCTURE_HINTS.some((hint) => key.toUpperCase().includes(hint))
            )
          );
          if (Object.keys(fields).length === 0 && Object.keys(nested).length === 0) return null;
          return {
            ledgerName: entry.ledgerName,
            amount: entry.amount,
            side: entry.side,
            tdsFields: fields,
            ...(Object.keys(nested).length === 0 ? {} : { tdsStructures: nested }),
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

      const hasTds =
        Object.keys(tdsFields).length > 0 ||
        Object.keys(tdsStructures).length > 0 ||
        entryTds.length > 0;

      if (!hasTds) return null;

      return {
        date: voucher.date,
        voucherNumber: voucher.voucherNumber,
        voucherType: voucher.voucherType,
        partyLedgerName: voucher.partyLedgerName,
        tdsFields,
        ...(Object.keys(tdsStructures).length === 0 ? {} : { tdsStructures }),
        ...(entryTds.length === 0 ? {} : { entries: entryTds }),
        source: voucher.source,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  assertResultSetFits(rows.length, deps.config, 'Narrow the date range.');

  const allWarnings = [...warnings];
  if (rows.length === 0 && vouchers.length > 0) {
    allWarnings.push(
      `${String(vouchers.length)} voucher(s) were found in this period but none carried TDS or ` +
        'TCS detail. Tally writes these fields as explicit negatives on ordinary transactions, ' +
        'and those are filtered out here rather than reported as content — so this means no tax ' +
        'was deducted in the period, not that the field was missing. Cross-check against the ' +
        'summary view: if expense ledgers ARE flagged for TDS but no voucher records a ' +
        'deduction, that gap is the finding.'
    );
  }

  return fromPage(paginate(rows, pagination, allWarnings), {
    view: 'transactions',
    period,
    vouchersExamined: vouchers.length,
  });
}
