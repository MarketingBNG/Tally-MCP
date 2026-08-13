import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildVoucherTypeListRequest } from '../tally/requests.js';
import { normalizeVoucherTypes, type VoucherType } from '../tally/normalize.js';
import {
  companySchema,
  conditionsSchema,
  paginationSchema,
  querySchema,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import { paginate, resolvePagination } from '../utils/pagination.js';
import { matchesText } from '../utils/text.js';
import {
  applyConditions,
  assertResultSetFits,
  fetchCollection,
  fromPage,
  runTool,
  type DatasetSpec,
  type ToolDeps,
} from './toolResult.js';

/**
 * `tally_get_voucher_types`: the voucher types this company actually defines.
 *
 * The server already reads this collection internally — `resolveFamilyTypes`
 * in vouchers.ts uses it to answer "which types are sales?" — but nothing
 * exposed the list itself, which left a real gap: a caller could filter
 * `tally_get_vouchers` by `voucherType` without any way to discover what the
 * valid values are on this company. Guessing "Sales" against a company that
 * calls it "Tax Invoice" returns zero rows and looks like an empty period.
 *
 * So this is a discovery tool first. It answers what to pass to
 * `voucherType`, and what a company's numbering practice is per type.
 */

const VOUCHER_TYPE_FIELDS: DatasetSpec<VoucherType> = {
  name: { type: 'string', get: (t) => t.name },
  parent: { type: 'string', get: (t) => t.parent },
  // Filters on the FIRST series' method. Every type observed live carries
  // exactly one series; where a company defines several, filtering on one of
  // them would be arbitrary, so the warning below says so rather than the
  // condition silently picking a series.
  numberingMethod: { type: 'string', get: (t) => t.numberingSeries[0]?.method ?? null },
  isDeemedPositive: { type: 'boolean', get: (t) => t.isDeemedPositive },
};

const NARROW_HINT =
  'This company defines more voucher types than the configured limit, which is unusual. Raise ' +
  'TALLY_MAX_RECORDS, or add a query/conditions filter.';

const DESCRIPTION = [
  'Voucher types defined in this company — the valid values for the `voucherType` filter on ' +
    'tally_get_vouchers, with the built-in type each derives from.',
  '',
  'WHEN TO USE: before filtering vouchers by type, and whenever a type-filtered query returns ' +
    'nothing. Type NAMES are company-specific — a company may record sales under "Tax Invoice" or ' +
    '"Export Invoice", neither containing the word "Sales" — so filtering on a guessed name ' +
    'silently under-reports. Also useful before reading anything into a repeated voucher number.',
  '',
  'MODES:',
  '- query: case-insensitive substring against name and parent, so "sales" finds "Sales" and ' +
    'anything deriving from it.',
  '- conditions: name (string), parent (string), numberingMethod (string, matching the FIRST ' +
    "series' method), isDeemedPositive (boolean). All AND together.",
  '- neither: list every type.',
  '',
  'RETURNS: per type — name, parent (the built-in base type), isDeemedPositive (Tally own ' +
    'debit/credit classification), and `numberingSeries`: one entry per series with Tally own ' +
    '`method` and `subMethod` labels and `preventsDuplicates`.',
  '',
  'DUPLICATE VOUCHER NUMBERS: read `preventsDuplicates` before drawing any conclusion from a ' +
    'repeat. False means TallyPrime would not have stopped one, so a repeat is unremarkable; with ' +
    'a "Manual" method it is a data-entry question; on an "Automatic" series WITH duplicates ' +
    'prevented it is stranger and worth investigating. Say which case you are looking at rather ' +
    'than calling a repeat an error on its own.',
  '',
  'An EMPTY `numberingSeries` means Tally reported no series, NOT that the type is unnumbered. Do ' +
    'not read absence as "None".',
  '',
  'PARENT IS THE RELIABLE FIELD: to find every sales voucher, do not match names — use ' +
    'tally_get_vouchers with family "sales", which resolves this list for you.',
  '',
  'DOES NOT RETURN: the vouchers themselves, or counts per type.',
  '',
  'PAGINATION: client-side. Most companies define well under 50 types.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

/**
 * One full fetch of the voucher type collection, with every field.
 *
 * All-fields is not optional here: the numbering setup lives in a nested
 * structure that the curated fetch cannot carry, and the curated fetch's
 * top-level numbering scalar reads `None` on every type regardless of the truth.
 * Small enough that there is no tradeoff to expose — 142 KB for 26 types live.
 */
export async function fetchVoucherTypes(
  deps: ToolDeps,
  company: string | undefined
): Promise<{ voucherTypes: VoucherType[]; warnings: string[] }> {
  const { data, warnings } = await fetchCollection<VoucherType>(deps, company, {
    build: (options) => buildVoucherTypeListRequest(options, true),
    normalize: normalizeVoucherTypes,
  });

  return { voucherTypes: data, warnings };
}

export function registerVoucherTypeTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_get_voucher_types',
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        query: querySchema,
        conditions: conditionsSchema,
        company: companySchema,
        ...paginationSchema,
      }),
    },
    async (args) =>
      runTool('tally_get_voucher_types', deps, async () => {
        const { voucherTypes, warnings } = await fetchVoucherTypes(deps, args.company);

        let matches = voucherTypes;
        if (args.query !== undefined) {
          // Parent is included so a search for "sales" surfaces the
          // company-specific types too — the whole point of the tool.
          matches = matches.filter((type) =>
            matchesText(args.query as string, type.name, type.parent)
          );
        }
        if (args.conditions !== undefined && args.conditions.length > 0) {
          matches = applyConditions(matches, VOUCHER_TYPE_FIELDS, args.conditions);
        }

        const pagination = resolvePagination(args.page, args.pageSize);
        assertResultSetFits(matches.length, deps.config, NARROW_HINT);

        return fromPage(paginate(matches, pagination, warnings), {
          ...(args.query === undefined ? {} : { query: args.query }),
        });
      })
  );
}
