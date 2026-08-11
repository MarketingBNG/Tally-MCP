import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildLedgerListRequest, buildVoucherRegisterRequest } from '../tally/requests.js';
import { normalizeLedgers, normalizeVouchers } from '../tally/normalize.js';
import {
  companySchema,
  dateRangeSchema,
  paginationSchema,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import { paginate, resolvePagination } from '../utils/pagination.js';
import {
  assertCompanyIsLoaded,
  assertResultSetFits,
  resolvePeriod,
  runTool,
  type ToolDeps,
} from './toolResult.js';

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

const SUMMARY_DESCRIPTION = [
  'GST position as TallyPrime records it: the tax ledgers, their balances, and the company GST ' +
    'registration details.',
  '',
  'WHEN TO USE: as the first GST call, to establish what this company records before asking ' +
    'about individual transactions.',
  '',
  'RETURNS: ledgers under the tax groups with their closing balances, plus the distinct GST ' +
    'registration fields found on the company party ledgers.',
  '',
  NO_CALCULATION_NOTICE,
  '',
  NOT_CONFIGURED_NOTICE,
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

const TRANSACTIONS_DESCRIPTION = [
  'Transactions carrying GST detail in a period, with the GST fields TallyPrime recorded on each.',
  '',
  'WHEN TO USE: to examine how GST was recorded on specific transactions — rates, tax amounts, ' +
    'registration types, place of supply — as entered rather than as computed.',
  '',
  'RETURNS: one row per voucher that has any GST field or GST structure, carrying the voucher ' +
    'identity plus those fields verbatim, under TallyPrime own field names.',
  '',
  'DERIVED FROM: the voucher register for the period, filtered to vouchers with GST content. ' +
    'Not a GST return report — see the note on calculation below.',
  '',
  NO_CALCULATION_NOTICE,
  '',
  NOT_CONFIGURED_NOTICE,
  '',
  'PERIOD: both dates or neither; omitted means the financial year containing today.',
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
    'tally_get_gst_summary',
    {
      description: SUMMARY_DESCRIPTION,
      inputSchema: z.object({
        taxGroups: z
          .array(z.string().min(1))
          .optional()
          .describe(
            `Groups holding tax ledgers. Defaults to ${DEFAULT_TAX_GROUPS.map((g) => `"${g}"`).join(', ')}. Override if this company uses different group names.`
          ),
        company: companySchema,
      }),
    },
    async (args) =>
      runTool('tally_get_gst_summary', deps.logger, async () => {
        await assertCompanyIsLoaded(deps, args.company);
        const companyOption = args.company === undefined ? {} : { company: args.company };
        const groups = args.taxGroups ?? [...DEFAULT_TAX_GROUPS];
        const groupSet = new Set(groups.map((group) => group.toLowerCase()));

        // Full fields: GST registration detail is not in the curated set.
        const response = await deps.client.send(
          buildLedgerListRequest(
            { ...companyOption, format: deps.config.tallyPreferredFormat },
            true
          ),
          'report'
        );
        const { data: ledgers, warnings } = normalizeLedgers(response.body, true);

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

        const allWarnings = [...response.repairs, ...warnings];
        if (taxLedgers.length === 0) {
          allWarnings.push(
            `No ledgers were found under ${groups.map((g) => `"${g}"`).join(', ')}. Either this company records no tax ledgers, or it groups them differently — check tally_list_ledgers.`
          );
        }

        return {
          taxGroupsUsed: groups,
          taxLedgers,
          registrationTypesInUse: Object.fromEntries(registrations),
          partiesWithGstin,
          ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
        };
      })
  );

  server.registerTool(
    'tally_get_gst_transactions',
    {
      description: TRANSACTIONS_DESCRIPTION,
      inputSchema: z.object({
        company: companySchema,
        ...dateRangeSchema,
        ...paginationSchema,
      }),
    },
    async (args) =>
      runTool('tally_get_gst_transactions', deps.logger, async () => {
        const pagination = resolvePagination(args.page, args.pageSize);
        const period = resolvePeriod(args.fromDate, args.toDate);
        await assertCompanyIsLoaded(deps, args.company);

        const response = await deps.client.send(
          buildVoucherRegisterRequest({
            ...(args.company === undefined ? {} : { company: args.company }),
            fromDate: period.fromDate,
            toDate: period.toDate,
            format: deps.config.tallyPreferredFormat,
          }),
          'report'
        );

        // GST detail is largely in nested structures, so full detail is needed.
        const { data: vouchers, warnings } = normalizeVouchers(response.body, true);

        // Company registration is identical on every voucher, so it is
        // reported once here rather than repeated on every row.
        const companyGstRegistration = Object.fromEntries(
          Object.entries(vouchers[0]?.fields ?? {}).filter(
            ([key, value]) =>
              isGstKey(key) &&
              isCompanyLevelGstKey(key) &&
              !UNINFORMATIVE_VALUES.has(value.trim().toLowerCase())
          )
        );

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

        const allWarnings = [...response.repairs, ...warnings];
        if (rows.length === 0 && vouchers.length > 0) {
          allWarnings.push(
            `${String(vouchers.length)} voucher(s) were found in this period but none carried transaction-level GST detail. Company-level GST registration fields, which Tally stamps on every voucher, are reported separately as companyGstRegistration and are deliberately not treated as GST content. This company may not apply GST to these transaction types.`
          );
        }

        return {
          period,
          /** The company's own registration, not transaction data. */
          companyGstRegistration,
          vouchersExamined: vouchers.length,
          ...paginate(rows, pagination, allWarnings),
        };
      })
  );
}
