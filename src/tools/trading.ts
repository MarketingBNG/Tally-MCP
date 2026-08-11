import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildVoucherRegisterRequest, buildVoucherTypeListRequest } from '../tally/requests.js';
import { normalizeVoucherTypes, normalizeVouchers, type Voucher } from '../tally/normalize.js';
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
import { matchesVoucherFilters } from './voucherFilters.js';

/**
 * Sales and purchase tools.
 *
 * ## How the family is resolved, and why it matters
 *
 * These are vouchers of a particular *family*, not a particular name. A
 * company can define its own voucher types — "GST Sales", "Tax Invoice",
 * "Export Sales" — each deriving from the built-in `Sales` type. Filtering on
 * the type name containing "sales" would silently miss "Tax Invoice" and
 * under-report, which in an audit is worse than failing.
 *
 * So the type list is fetched from Tally and matched on `Parent`, the base
 * type, which is authoritative. The resolved type names are echoed back in the
 * response so it is visible which types were actually included.
 *
 * ## No totals
 *
 * These tools deliberately return no summed total. Which entry on a sales
 * voucher constitutes "the sale" is an interpretation — party side, revenue
 * ledger net of tax, or gross including tax — and picking one silently would
 * present a judgement as a fact. The vouchers and their entries are returned
 * in full; the caller can total whatever it decides is the right basis, and
 * say so.
 */

interface FamilySpec {
  /** Base voucher type in Tally, matched against VoucherType Parent. */
  family: string;
  listTool: string;
  searchTool: string;
  label: string;
  /** What this family means, in the tool description. */
  meaning: string;
}

const FAMILIES: readonly FamilySpec[] = [
  {
    family: 'Sales',
    listTool: 'tally_get_sales',
    searchTool: 'tally_search_sales',
    label: 'sales',
    meaning:
      'Vouchers in the Sales family — every voucher type deriving from the built-in Sales type, ' +
      'including company-specific types such as "GST Sales" or "Tax Invoice".',
  },
  {
    family: 'Purchase',
    listTool: 'tally_get_purchases',
    searchTool: 'tally_search_purchases',
    label: 'purchases',
    meaning:
      'Vouchers in the Purchase family — every voucher type deriving from the built-in Purchase ' +
      'type, including company-specific ones.',
  },
];

const SHARED_NOTES = [
  'TYPE RESOLUTION: the voucher types included are resolved from TallyPrime own voucher type ' +
    'list by base type, not by matching names, so company-specific type names are covered. The ' +
    'types actually used are echoed back as "voucherTypesIncluded" — check it if a count looks ' +
    'wrong.',
  '',
  'NO TOTALS: no summed figure is returned. Which entry represents "the sale" — party side, ' +
    'revenue net of tax, or gross — is an interpretation, not a fact, so the full entries are ' +
    'returned and the choice is left to you. If you total them, say which basis you used.',
  '',
  'RETURNS: full vouchers with every ledger entry. Set includeAllFields for nested inventory, ' +
    'tax and bank detail.',
  '',
  'PERIOD: both dates or neither; omitted means the financial year containing today, echoed ' +
    'back. Narrowing the period is the only way to make the query cheaper.',
  '',
  'NOTE: returns nothing if the company records no vouchers of this family in the period. That ' +
    'is a real answer, not a failure.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

const allFieldsSchema = z
  .boolean()
  .optional()
  .describe(
    'Include every field and nested structure TallyPrime holds on each voucher — inventory ' +
      'lines, tax breakdowns, bank details. No extra retrieval cost; only a larger response. ' +
      'Defaults to false.'
  );

/**
 * Resolve which voucher type names belong to a family.
 *
 * Falls back to the family name itself if Tally reports no type list, so the
 * tool degrades to the built-in type rather than matching nothing at all.
 */
async function resolveFamilyTypes(
  deps: ToolDeps,
  company: string | undefined,
  family: string
): Promise<{ types: Set<string>; warnings: string[] }> {
  const response = await deps.client.send(
    buildVoucherTypeListRequest(company === undefined ? {} : { company }),
    'standard'
  );
  const { data, warnings } = normalizeVoucherTypes(response.body);

  const target = family.toLowerCase();
  const types = new Set<string>();

  for (const type of data) {
    if ((type.parent ?? '').toLowerCase() === target || type.name.toLowerCase() === target) {
      types.add(type.name.toLowerCase());
    }
  }

  if (types.size === 0) {
    types.add(target);
    warnings.push(
      `TallyPrime reported no voucher types deriving from "${family}", so only the built-in "${family}" type was matched. If this company uses a custom type name, check tally_get_company.`
    );
  }

  return { types, warnings: [...response.repairs, ...warnings] };
}

async function fetchFamilyVouchers(
  deps: ToolDeps,
  company: string | undefined,
  period: { fromDate: string; toDate: string },
  family: string,
  allFields: boolean
): Promise<{ vouchers: Voucher[]; typeNames: string[]; warnings: string[] }> {
  await assertCompanyIsLoaded(deps, company);

  const { types, warnings: typeWarnings } = await resolveFamilyTypes(deps, company, family);

  const response = await deps.client.send(
    buildVoucherRegisterRequest({
      ...(company === undefined ? {} : { company }),
      fromDate: period.fromDate,
      toDate: period.toDate,
      format: deps.config.tallyPreferredFormat,
    }),
    'report'
  );
  const { data, warnings } = normalizeVouchers(response.body, allFields);

  const matched = data.filter((voucher) =>
    types.has((voucher.voucherType ?? '').toLowerCase())
  );

  return {
    vouchers: matched,
    typeNames: [...types],
    warnings: [...typeWarnings, ...response.repairs, ...warnings],
  };
}

export function registerTradingTools(server: McpServer, deps: ToolDeps): void {
  for (const spec of FAMILIES) {
    server.registerTool(
      spec.listTool,
      {
        description: [
          `List ${spec.label} recorded in a period.`,
          '',
          spec.meaning,
          '',
          `WHEN TO USE: to review ${spec.label} activity over a period, or as the starting point ` +
            `for questions about what was ${spec.family === 'Sales' ? 'sold and to whom' : 'bought and from whom'}.`,
          '',
          SHARED_NOTES,
        ].join('\n'),
        inputSchema: z.object({
          company: companySchema,
          includeAllFields: allFieldsSchema,
          ...dateRangeSchema,
          ...paginationSchema,
        }),
      },
      async (args) =>
        runTool(spec.listTool, deps.logger, async () => {
          const pagination = resolvePagination(args.page, args.pageSize);
          const period = resolvePeriod(args.fromDate, args.toDate);

          const { vouchers, typeNames, warnings } = await fetchFamilyVouchers(
            deps,
            args.company,
            period,
            spec.family,
            args.includeAllFields ?? false
          );
          assertResultSetFits(
            vouchers.length,
            deps.config,
            'Narrow the date range — Tally returns the whole period in one response.'
          );

          return {
            period,
            voucherTypesIncluded: typeNames,
            ...paginate(vouchers, pagination, warnings),
          };
        })
    );

    server.registerTool(
      spec.searchTool,
      {
        description: [
          `Find ${spec.label} in a period matching a party, an amount range, or any field value.`,
          '',
          spec.meaning,
          '',
          `WHEN TO USE: to narrow ${spec.label} down to the transactions of interest — a ` +
            'particular customer or supplier, entries above a threshold, or a reference number.',
          '',
          'MATCHING: all supplied filters must match (AND), case-insensitive substring. ' +
            '"party" matches the party ledger; "query" also covers voucher number, narration and ' +
            'entry ledger names; "fieldMatch" searches every field value including nested ' +
            'structures. minAmount/maxAmount compare against the largest absolute entry amount.',
          '',
          'THRESHOLDS ARE YOURS: no threshold is applied that you did not supply, and this ' +
            'server has no notion of a large or unusual transaction.',
          '',
          SHARED_NOTES,
        ].join('\n'),
        inputSchema: z.object({
          query: z.string().min(1).optional().describe('Broad substring match.'),
          party: z
            .string()
            .min(1)
            .optional()
            .describe('Match the party ledger name on the voucher.'),
          fieldMatch: z
            .string()
            .min(1)
            .optional()
            .describe('Match the value of any field, including nested structures.'),
          minAmount: z.number().optional().describe('Minimum largest-entry amount.'),
          maxAmount: z.number().optional().describe('Maximum largest-entry amount.'),
          company: companySchema,
          includeAllFields: allFieldsSchema,
          ...dateRangeSchema,
          ...paginationSchema,
        }),
      },
      async (args) =>
        runTool(spec.searchTool, deps.logger, async () => {
          const pagination = resolvePagination(args.page, args.pageSize);
          const period = resolvePeriod(args.fromDate, args.toDate);

          // fieldMatch needs fields parsed even when not requested for output.
          const needsFields = (args.includeAllFields ?? false) || args.fieldMatch !== undefined;

          const { vouchers, typeNames, warnings } = await fetchFamilyVouchers(
            deps,
            args.company,
            period,
            spec.family,
            needsFields
          );

          const matches = vouchers.filter((voucher) =>
            matchesVoucherFilters(voucher, {
              ...(args.query === undefined ? {} : { query: args.query }),
              ...(args.party === undefined ? {} : { party: args.party }),
              ...(args.fieldMatch === undefined ? {} : { fieldMatch: args.fieldMatch }),
              ...(args.minAmount === undefined ? {} : { minAmount: args.minAmount }),
              ...(args.maxAmount === undefined ? {} : { maxAmount: args.maxAmount }),
            })
          );

          return {
            period,
            voucherTypesIncluded: typeNames,
            filters: {
              ...(args.query === undefined ? {} : { query: args.query }),
              ...(args.party === undefined ? {} : { party: args.party }),
              ...(args.fieldMatch === undefined ? {} : { fieldMatch: args.fieldMatch }),
              ...(args.minAmount === undefined ? {} : { minAmount: args.minAmount }),
              ...(args.maxAmount === undefined ? {} : { maxAmount: args.maxAmount }),
            },
            ...paginate(matches, pagination, warnings),
          };
        })
    );
  }
}

