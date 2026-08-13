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
  resolvePeriod,
  runTool,
  whole,
  type ToolBodyResult,
  type ToolDeps,
} from './toolResult.js';
import { fetchLedgers } from './ledgers.js';
import { fetchVouchers } from './vouchers.js';

/**
 * GST tools.
 *
 * ## Retrieved, never calculated
 *
 * These return GST data **as TallyPrime recorded it** and compute nothing. No
 * tax liability is derived, no rate is applied, no return figure is assembled.
 * That is a deliberate limit, not an omission: a GST return depends on
 * registration type, place of supply, reverse charge, input credit
 * eligibility and exemptions, and a plausible-looking figure produced from
 * incomplete inputs is worse than no figure — someone might file it.
 *
 * What is returned: the GST fields Tally holds, the tax ledgers and their
 * balances, and the GST structures nested on individual vouchers. Enough to
 * answer "what did Tally record", which is the answerable question.
 *
 * ## Retrieval path
 *
 * Derived from the verified voucher and ledger paths rather than a dedicated
 * GST report, whose export ID is unconfirmed — and an unconfirmed report ID
 * can terminate TallyPrime rather than fail. Which GST fields exist depends on
 * the company: one without GST configured will legitimately return nothing.
 */

const NO_CALCULATION_NOTICE =
  'NOTHING IS CALCULATED. This returns GST data exactly as TallyPrime recorded it. No tax ' +
  'liability, no return figure and no rate application is derived here, because that depends on ' +
  'registration type, place of supply, reverse charge and credit eligibility — and a figure ' +
  'assembled from partial inputs could end up being filed. If asked for a GST liability, report ' +
  'what Tally recorded and state plainly that computing the return is out of scope.';

const NOT_CONFIGURED_NOTICE =
  'IF EMPTY: a company without GST configured returns nothing here, and that is a real answer ' +
  'rather than a failure. Check tally_get_company — if GSTREGISTRATIONTYPE and related fields ' +
  'are absent from distinguishingFields, this company does not record GST.';

const viewSchema = z
  .enum(['summary', 'transactions'])
  .describe(
    'summary: tax ledgers, balances and company GST registration details, no period needed. ' +
      'transactions: individual vouchers carrying GST detail in a period.'
  );

const DESCRIPTION = [
  'GST data as TallyPrime records it, picked by `view` — one call, one view.',
  '',
  'summary: the tax ledgers, their balances, and the company GST registration details. WHEN TO ' +
    'USE: as the first GST call, to establish what this company records before asking about ' +
    'individual transactions. RETURNS: ledgers under the tax groups with their closing balances, ' +
    'plus the distinct GST registration fields found on the company party ledgers. Needs no period.',
  '',
  'transactions: individual vouchers carrying GST detail in a period, with the GST fields ' +
    'TallyPrime recorded on each. WHEN TO USE: to examine how GST was recorded on specific ' +
    'transactions — rates, tax amounts, registration types, place of supply — as entered rather ' +
    'than as computed. RETURNS: one row per voucher that has any GST field or GST structure, ' +
    'carrying the voucher identity plus those fields verbatim, under TallyPrime own field names. ' +
    'DERIVED FROM: the voucher register for the period, filtered to vouchers with GST content. ' +
    'Requires fromDate/toDate (or accepts the default financial-year period).',
  '',
  NO_CALCULATION_NOTICE,
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
 * Field-name fragments that mark GST content.
 *
 * `GST` alone covers IGST, CGST and SGST, which all contain it.
 *
 * `CESS` is deliberately NOT here: Tally field names are concatenated
 * upper-case words with no separators, so a bare substring match on `CESS`
 * also matches `PROCESS`. Cess fields not named with `GST` are therefore
 * missed rather than risk false positives — a known, bounded gap. See
 * FALSE_POSITIVE_KEYS for the same problem in the other direction.
 */
const GST_FIELD_HINTS = ['GST', 'HSN', 'PLACEOFSUPPLY'];

/**
 * Keys that contain a GST hint as a coincidence of spelling.
 *
 * `NUMBERINGSTYLE` contains "GST" — numberin·**GST**·yle — and Tally sets it on
 * every voucher, so before this denylist every voucher in a period looked like
 * a GST transaction. Substring matching over concatenated upper-case names is
 * inherently approximate; this is the escape hatch, and new entries belong here
 * as they are found against real data.
 */
const FALSE_POSITIVE_KEYS = new Set(['NUMBERINGSTYLE']);

/** Nested structures Tally uses for GST detail. */
const GST_STRUCTURE_HINTS = ['GST', 'HSN', 'RATEDETAILS', 'DUTYHEAD'];

/**
 * Company-level GST fields Tally stamps onto EVERY voucher, by exact name.
 *
 * These are not `CMP`-prefixed but still describe the company rather than the
 * transaction. Observed identically on all 30 vouchers of a real month,
 * including plain bank payments.
 */
const COMPANY_GST_FIELD_NAMES = new Set(['GSTREGISTRATION', 'GSTREGISTRATIONNAME']);

/**
 * Company-level GST fields, stamped by Tally onto EVERY voucher.
 *
 * `CMPGSTREGISTRATIONTYPE`, `CMPGSTSTATE`, `GSTREGISTRATION` and friends
 * describe the company's own registration, not the transaction. Treating them
 * as GST content makes every voucher — including plain bank payments — look
 * like a GST transaction, which is exactly what happened against real data
 * before this filter existed: all 30 vouchers in the period were returned.
 * They are reported once at the top level instead of on every row.
 */
function isCompanyLevelGstKey(key: string): boolean {
  const upper = key.toUpperCase();
  return upper.startsWith('CMP') || COMPANY_GST_FIELD_NAMES.has(upper);
}

/**
 * Values that carry no information even on a GST field.
 *
 * Tally populates GST fields with explicit negatives on transactions that have
 * no GST at all, so presence alone does not indicate GST content.
 */
const UNINFORMATIVE_VALUES = new Set(['', 'not applicable', 'no', '0', '0.00', 'unknown']);

function isGstKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (FALSE_POSITIVE_KEYS.has(upper)) return false;
  return GST_FIELD_HINTS.some((hint) => upper.includes(hint));
}

/** A GST field that says something about THIS transaction. */
function isTransactionGstEntry([key, value]: [string, string]): boolean {
  if (!isGstKey(key) || isCompanyLevelGstKey(key)) return false;
  return !UNINFORMATIVE_VALUES.has(value.trim().toLowerCase());
}

export function registerGstTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_get_gst',
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
      runTool('tally_get_gst', deps, async () => {
        if (args.view === 'summary') return fetchGstSummary(deps, args);
        return fetchGstTransactions(deps, args);
      })
  );
}

async function fetchGstSummary(
  deps: ToolDeps,
  args: { taxGroups?: string[] | undefined; company?: string | undefined }
): Promise<ToolBodyResult> {
  const groups = args.taxGroups ?? [...DEFAULT_TAX_GROUPS];
  const groupSet = new Set(groups.map((group) => group.toLowerCase()));

  // Full fields: GST registration detail is not in the curated set.
  const { ledgers, warnings } = await fetchLedgers(deps, args.company, true);

  const taxLedgers = ledgers
    .filter((ledger) => groupSet.has((ledger.parent ?? '').toLowerCase()))
    .map((ledger) => ({
      name: ledger.name,
      group: ledger.parent,
      closingBalance: ledger.closingBalance,
      gstFields: Object.fromEntries(
        Object.entries(ledger.fields ?? {}).filter(([key]) => isGstKey(key))
      ),
      source: ledger.source,
    }));

  // Registration details as recorded on party ledgers, with counts, so
  // it is visible how widely each value is actually used.
  const registrations = new Map<string, number>();
  for (const ledger of ledgers) {
    const type = ledger.fields?.GSTREGISTRATIONTYPE;
    if (type !== undefined) registrations.set(type, (registrations.get(type) ?? 0) + 1);
  }

  const partiesWithGstin = ledgers.filter((ledger) => ledger.gstin !== null).length;

  const allWarnings = [...warnings];
  if (taxLedgers.length === 0) {
    allWarnings.push(
      `No ledgers were found under ${groups.map((g) => `"${g}"`).join(', ')}. Either this company records no tax ledgers, or it groups them differently — check tally_get_ledgers.`
    );
  }

  // Every tax ledger under the requested groups is returned; the summary view
  // is not paginated and applies no cap of its own.
  return whole(
    {
      view: 'summary',
      taxGroupsUsed: groups,
      taxLedgers,
      registrationTypesInUse: Object.fromEntries(registrations),
      partiesWithGstin,
      ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
    },
    taxLedgers.length
  );
}

async function fetchGstTransactions(
  deps: ToolDeps,
  args: {
    company?: string | undefined;
    fromDate?: string | undefined;
    toDate?: string | undefined;
    page?: number | undefined;
    pageSize?: number | undefined;
  }
): Promise<ToolBodyResult> {
  // Always field-heavy: GST detail lives in fields and nested structures,
  // so this path parses full detail whether or not the caller asked.
  const pagination = resolvePagination(args.page, args.pageSize, FIELD_HEAVY_PAGE_SIZE);
  const period = resolvePeriod(args.fromDate, args.toDate);

  // GST detail is largely in nested structures, so full detail is needed.
  const { vouchers, warnings } = await fetchVouchers(deps, args.company, period, true);

  // Company registration is identical on every voucher, so it is
  // reported once here rather than repeated on every row.
  //
  // Unioned across every voucher rather than read from vouchers[0]. Whether
  // that first voucher happens to carry the fields depends on Tally's
  // ordering and on the voucher's own type, so reading only it reported
  // `companyGstRegistration: {}` while every other voucher in the period
  // held the registration — and the empty-result note below then invites
  // the reader to conclude the company may not apply GST at all. First
  // populated value per key wins; they agree by construction.
  const companyGstRegistration: Record<string, string> = {};
  for (const voucher of vouchers) {
    for (const [key, value] of Object.entries(voucher.fields ?? {})) {
      if (!isGstKey(key) || !isCompanyLevelGstKey(key)) continue;
      if (UNINFORMATIVE_VALUES.has(value.trim().toLowerCase())) continue;
      companyGstRegistration[key] ??= value;
    }
  }

  const rows = vouchers
    .map((voucher) => {
      const gstFields = Object.fromEntries(
        Object.entries(voucher.fields ?? {}).filter(isTransactionGstEntry)
      );

      const gstStructures = Object.fromEntries(
        Object.entries(voucher.nested ?? {}).filter(([key]) =>
          GST_STRUCTURE_HINTS.some((hint) => key.toUpperCase().includes(hint))
        )
      );

      const entryGst = voucher.entries
        .map((entry) => {
          const fields = Object.fromEntries(
            Object.entries(entry.fields ?? {}).filter(isTransactionGstEntry)
          );
          const nested = Object.fromEntries(
            Object.entries(entry.nested ?? {}).filter(([key]) =>
              GST_STRUCTURE_HINTS.some((hint) => key.toUpperCase().includes(hint))
            )
          );
          if (Object.keys(fields).length === 0 && Object.keys(nested).length === 0) {
            return null;
          }
          return {
            ledgerName: entry.ledgerName,
            amount: entry.amount,
            side: entry.side,
            gstFields: fields,
            ...(Object.keys(nested).length === 0 ? {} : { gstStructures: nested }),
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

      const hasGst =
        Object.keys(gstFields).length > 0 ||
        Object.keys(gstStructures).length > 0 ||
        entryGst.length > 0;

      if (!hasGst) return null;

      return {
        date: voucher.date,
        voucherNumber: voucher.voucherNumber,
        voucherType: voucher.voucherType,
        partyLedgerName: voucher.partyLedgerName,
        gstFields,
        ...(Object.keys(gstStructures).length === 0 ? {} : { gstStructures }),
        ...(entryGst.length === 0 ? {} : { entries: entryGst }),
        source: voucher.source,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  assertResultSetFits(rows.length, deps.config, 'Narrow the date range.');

  const allWarnings = [...warnings];
  if (rows.length === 0 && vouchers.length > 0) {
    allWarnings.push(
      `${String(vouchers.length)} voucher(s) were found in this period but none carried transaction-level GST detail. Company-level GST registration fields, which Tally stamps on every voucher, are reported separately as companyGstRegistration and are deliberately not treated as GST content. This company may not apply GST to these transaction types.`
    );
  }

  return fromPage(paginate(rows, pagination, allWarnings), {
    view: 'transactions',
    period,
    /** The company's own registration, not transaction data. */
    companyGstRegistration,
    vouchersExamined: vouchers.length,
  });
}
