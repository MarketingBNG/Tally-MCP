import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { TallyError } from '../tally/TallyError.js';
import type { Group, Ledger, StockItem, VoucherType } from '../tally/normalize.js';
import {
  allFieldsSchema,
  companySchema,
  conditionsSchema,
  nameSchema,
  paginationSchema,
  querySchema,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import {
  DEFAULT_PAGE_SIZE,
  FIELD_HEAVY_PAGE_SIZE,
  paginate,
  resolvePagination,
} from '../utils/pagination.js';
import { matchesText } from '../utils/text.js';
import { foldUniformFields, uniformFieldsNote } from '../utils/uniformFields.js';
import {
  applyConditions,
  assertResultSetFits,
  findByName,
  fromPage,
  runTool,
  whole,
  type DatasetSpec,
  type ToolDeps,
} from './toolResult.js';
import { fetchLedgers } from './ledgers.js';
import { fetchGroups } from './groups.js';
import { fetchVoucherTypes } from './voucherTypes.js';
import { fetchStockItems } from './inventory.js';

/**
 * `tally_get_masters`: one tool over the four master lists.
 *
 * These were four separate tools with *identical* parameter shapes — query,
 * conditions, company, includeAllFields, page, pageSize — over the same
 * fetch-everything-then-filter-here mechanism, because TallyPrime has no
 * server-side search or filter for masters. Four tool descriptions sent every
 * turn to say the same thing four times is a standing context cost for no
 * discrimination gain, so they are one tool with a `type` enum.
 *
 * The thing that makes this merge safe rather than lossy: each type's
 * type-SPECIFIC caveats are preserved verbatim under a per-type heading in the
 * description below, and the per-record warnings each type raises are untouched.
 * A merged tool whose single generic caveat paragraph has swallowed the
 * voucher-type duplicate-numbering guidance, or the ledger balance-sign rule,
 * would have quietly lost the most load-bearing sentences in the old
 * descriptions — and no test would have failed.
 */

/** What one master type needs in order to be served by the shared handler. */
interface MasterKind<T> {
  /** Singular noun used in errors, warnings and the folded-fields note. */
  readonly label: string;
  readonly fetch: (
    deps: ToolDeps,
    company: string | undefined,
    allFields: boolean
  ) => Promise<{ data: T[]; warnings: string[] }>;
  readonly fields: DatasetSpec<T>;
  /** Text values `query` matches against, in order. */
  readonly searchText: (record: T) => (string | null)[];
  /**
   * Whether `name` may be used to fetch exactly one record. Groups and voucher
   * types are small enough that a `query` fragment is always sufficient, and
   * neither had an exact-fetch mode to preserve.
   */
  readonly supportsName: boolean;
  /**
   * Whether `includeAllFields` means anything. Groups carry no all-fields
   * variant; voucher types are ALWAYS fetched with every field, because the
   * curated fetch reports `None` for the numbering method on every type
   * regardless of the truth — so exposing the flag there would offer a choice
   * between a right answer and a wrong one.
   */
  readonly allFieldsIsMeaningful: boolean;
  /** The open field map to fold, when this type has one. */
  readonly openFields?: (record: T) => Record<string, string> | undefined;
  readonly withOpenFields?: (record: T, fields: Record<string, string>) => T;
  readonly narrowHint: string;
}

const LEDGER_KIND: MasterKind<Ledger> = {
  label: 'ledger',
  fetch: async (deps, company, allFields) => {
    const { ledgers, warnings } = await fetchLedgers(deps, company, allFields);
    return { data: ledgers, warnings };
  },
  fields: {
    name: { type: 'string', get: (l) => l.name },
    parent: { type: 'string', get: (l) => l.parent },
    gstin: { type: 'string', get: (l) => l.gstin },
    openingBalance: { type: 'money', get: (l) => l.openingBalance },
    closingBalance: { type: 'money', get: (l) => l.closingBalance },
  },
  searchText: (l) => [l.name, l.parent],
  supportsName: true,
  allFieldsIsMeaningful: true,
  openFields: (l) => l.fields,
  withOpenFields: (l, fields) => ({ ...l, fields }),
  narrowHint:
    'This company has more ledgers than the configured limit. Raise TALLY_MAX_RECORDS, or add a ' +
    'name/query/conditions filter to narrow instead of listing everything.',
};

const GROUP_KIND: MasterKind<Group> = {
  label: 'group',
  fetch: async (deps, company) => {
    const { groups, warnings } = await fetchGroups(deps, company);
    return { data: groups, warnings };
  },
  fields: {
    name: { type: 'string', get: (g) => g.name },
    parent: { type: 'string', get: (g) => g.parent },
    isRevenue: { type: 'boolean', get: (g) => g.isRevenue },
    isDeemedPositive: { type: 'boolean', get: (g) => g.isDeemedPositive },
  },
  // Name only, deliberately: a group's `parent` is another group, so including
  // it would make "Direct Expenses" match every group filed under it, which is
  // the opposite of what someone searching the hierarchy by name wants.
  searchText: (g) => [g.name],
  supportsName: false,
  allFieldsIsMeaningful: false,
  narrowHint:
    'This company has more groups than the configured limit. Raise TALLY_MAX_RECORDS, or add a ' +
    'query/conditions filter to narrow instead of listing everything.',
};

const VOUCHER_TYPE_KIND: MasterKind<VoucherType> = {
  label: 'voucher type',
  fetch: async (deps, company) => {
    const { voucherTypes, warnings } = await fetchVoucherTypes(deps, company);
    return { data: voucherTypes, warnings };
  },
  fields: {
    name: { type: 'string', get: (t) => t.name },
    parent: { type: 'string', get: (t) => t.parent },
    // Filters on the FIRST series' method. Every type observed live carries
    // exactly one series; where a company defines several, filtering on one of
    // them would be arbitrary.
    numberingMethod: { type: 'string', get: (t) => t.numberingSeries[0]?.method ?? null },
    isDeemedPositive: { type: 'boolean', get: (t) => t.isDeemedPositive },
  },
  // Parent IS included here, and that is the whole point of the tool: a company
  // recording sales under "Tax Invoice" is found by searching "sales" only
  // because the parent names the built-in type it derives from.
  searchText: (t) => [t.name, t.parent],
  supportsName: false,
  allFieldsIsMeaningful: false,
  narrowHint:
    'This company defines more voucher types than the configured limit, which is unusual. Raise ' +
    'TALLY_MAX_RECORDS, or add a query/conditions filter.',
};

const STOCK_ITEM_KIND: MasterKind<StockItem> = {
  label: 'stock item',
  fetch: async (deps, company, allFields) => {
    const { items, warnings } = await fetchStockItems(deps, company, allFields);
    return { data: items, warnings };
  },
  fields: {
    name: { type: 'string', get: (s) => s.name },
    parent: { type: 'string', get: (s) => s.parent },
    closingValue: { type: 'money', get: (s) => s.closingValue },
    openingValue: { type: 'money', get: (s) => s.openingValue },
  },
  searchText: (s) => [s.name, s.parent],
  supportsName: true,
  allFieldsIsMeaningful: true,
  openFields: (s) => s.fields,
  withOpenFields: (s, fields) => ({ ...s, fields }),
  narrowHint:
    'This company has more stock items than the configured limit. Raise TALLY_MAX_RECORDS, or add ' +
    'a name/query/conditions filter to narrow.',
};

/** The four kinds, keyed by the `type` a caller passes. */
export const MASTER_KINDS = {
  ledger: LEDGER_KIND,
  group: GROUP_KIND,
  voucherType: VOUCHER_TYPE_KIND,
  stockItem: STOCK_ITEM_KIND,
} as const;

export type MasterType = keyof typeof MASTER_KINDS;

/** The result key each type returns under, kept as it was before the merge. */
const RESULT_KEY: Record<MasterType, string> = {
  ledger: 'ledger',
  group: 'group',
  voucherType: 'voucherType',
  stockItem: 'item',
};

const DESCRIPTION = [
  'Master data — the things a company defines, as opposed to what it records against them. Pick ' +
    'one with `type`: ledger accounts, chart-of-accounts groups, voucher types, or stock items.',
  '',
  'MODES, identical for every type — one call, one mode, picked by which parameters are given:',
  '- name given: fetch that one record with every field TallyPrime holds. Fails with ' +
    'TALLY_COMPANY_NOT_FOUND naming what was asked for, rather than returning null, so a typo is ' +
    'distinguishable from a record that genuinely has no data. Applies to ledger and stockItem; ' +
    'for group and voucherType use `query`, which on those small lists is always enough.',
  '- query given: case-insensitive substring — "Gupta" finds "Gupta Traders", "Gupt" does too, ' +
    '"Gupat" does not. What it searches differs by type; see below.',
  '- conditions given: combine several fields at once, all ANDed. An unknown field, or an op ' +
    "invalid for that field's type, fails with INVALID_PARAMETERS rather than being ignored.",
  '- none given: list everything of that type.',
  'name, query and conditions may be combined; each narrows the result further.',
  '',
  'FILTERABLE FIELDS AND WHAT `query` SEARCHES, per type:',
  '- ledger: name (string), parent (string), gstin (string), openingBalance (money), ' +
    'closingBalance (money). query searches name and parent group.',
  '- group: name (string), parent (string), isRevenue (boolean), isDeemedPositive (boolean). ' +
    'query searches the group name ONLY — matching parent too would make "Direct Expenses" ' +
    'return every group under it.',
  '- voucherType: name (string), parent (string), numberingMethod (string, matching the FIRST ' +
    "series' method), isDeemedPositive (boolean). query searches name AND parent.",
  '- stockItem: name (string), parent (string), openingValue (money), closingValue (money). ' +
    'query searches name and parent group. Every other stock item field lives in the open ' +
    '"fields" map and is not filterable — fetch by name for full detail on one item.',
  '',
  'TYPE-SPECIFIC NOTES. These are not interchangeable; read the one for the type being asked.',
  '',
  'ledger — BALANCES: signed exactly as TallyPrime reports them, where a negative closing ' +
    'balance denotes a debit balance. Signs are never adjusted. A null balance means Tally ' +
    'returned an empty value, which is NOT the same as a balance of zero — a real zero is ' +
    'reported as 0. Returns no transactions: this is master data only, use tally_get_vouchers ' +
    'for entries.',
  '',
  'group — returns name, parent (null for a primary/top-level group), isRevenue (true for P&L ' +
    'groups such as income and expenses, false for balance sheet groups), and isDeemedPositive ' +
    "(Tally's debit/credit classification). Groups carry NO BALANCE in Tally, so none is " +
    'returned, and the ledgers filed under a group are not included — for those, ask for ' +
    'type "ledger" with the group name as `query`. Use this type to check whether a group is a ' +
    'balance sheet or a P&L group before interpreting a ledger filed under it.',
  '',
  'voucherType — this is the DISCOVERY step for the `voucherType` filter on tally_get_vouchers, ' +
    'and the thing to reach for whenever a type-filtered query returns nothing. Type NAMES are ' +
    'company-specific: a company may record sales under "Tax Invoice" or "Export Invoice", ' +
    'neither containing the word "Sales", so filtering on a guessed name silently ' +
    'under-reports. Returns per type: name, parent (the built-in base type), isDeemedPositive, ' +
    'and `numberingSeries` — one entry per series with Tally own `method` and `subMethod` labels ' +
    'and `preventsDuplicates`.',
  '  DUPLICATE VOUCHER NUMBERS: read `preventsDuplicates` before drawing any conclusion from a ' +
    'repeat. False means TallyPrime would not have stopped one, so a repeat is unremarkable; ' +
    'with a "Manual" method it is a data-entry question; on an "Automatic" series WITH ' +
    'duplicates prevented it is stranger and worth investigating. Say which case you are ' +
    'looking at rather than calling a repeat an error on its own.',
  '  An EMPTY `numberingSeries` means Tally reported no series, NOT that the type is ' +
    'unnumbered. Do not read absence as "None".',
  '  PARENT IS THE RELIABLE FIELD: to find every sales voucher, do not match names — use ' +
    'tally_get_vouchers with family "sales", which resolves this list for you.',
  '',
  'stockItem — returns nothing for a company that does not keep stock, which is a real answer ' +
    'rather than an error; check tally_get_company before reading an empty list as missing data. ' +
    'Name, parent group, base unit, opening/closing balance and value, and closing rate are ' +
    'named properties, verified against live inventory data. Every other value appears under ' +
    '"fields" under TallyPrime own field names rather than being renamed.',
  '',
  'COST: TallyPrime cannot filter or search masters server-side, so the FULL list of that type ' +
    'is fetched and filtered here in every mode. A narrower filter is not a cheaper request; it ' +
    'is only a smaller response.',
  '',
  'PAGINATION: client-side, for the same reason. A small pageSize does NOT make the call cheap.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

export function registerMasterTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_get_masters',
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        type: z
          .enum(['ledger', 'group', 'voucherType', 'stockItem'])
          .describe(
            'Which master list to read. Required — there is no default, because the four are ' +
              'different questions and guessing one would answer the wrong one silently.'
          ),
        name: nameSchema,
        query: querySchema,
        conditions: conditionsSchema,
        company: companySchema,
        includeAllFields: allFieldsSchema,
        ...paginationSchema,
      }),
    },
    async (args) =>
      runTool('tally_get_masters', deps, async () => {
        const type: MasterType = args.type;
        const kind = MASTER_KINDS[type] as MasterKind<unknown>;

        if (args.name !== undefined && !kind.supportsName) {
          throw new TallyError(
            'INVALID_PARAMETERS',
            `Master type "${type}" has no exact-name mode.`,
            {
              suggestion:
                'Pass the name as `query` instead. That list is small enough that a substring ' +
                'match is unambiguous in practice.',
            }
          );
        }

        // A named lookup defaults to the full record — asking for one specific
        // record is normally an investigation, and the whole record is what
        // makes that answerable. Where all-fields is not a real choice, the
        // flag is ignored rather than honoured into a worse answer.
        const allFields = kind.allFieldsIsMeaningful
          ? (args.includeAllFields ?? args.name !== undefined)
          : false;

        const { data, warnings } = await kind.fetch(deps, args.company, allFields);

        if (args.name !== undefined) {
          // Every kind's spec has a `name` field; the fallback is only here
          // because the DatasetSpec index signature cannot promise it.
          const nameOf = kind.fields.name;
          const record = findByName(data, args.name, (candidate) => {
            const value = nameOf === undefined ? null : nameOf.get(candidate);
            return typeof value === 'string' ? value : '';
          });
          if (record === undefined) {
            throw new TallyError(
              'TALLY_COMPANY_NOT_FOUND',
              `No ${kind.label} named "${args.name}" exists in the loaded company.`,
              {
                suggestion:
                  data.length === 0
                    ? `This company reports no ${kind.label}s at all, so the name is not the ` +
                      'problem — check whether the company uses this feature.'
                    : 'Check the spelling, or call this tool with a `query` fragment to find it ' +
                      'by name.',
              }
            );
          }
          return whole(
            { [RESULT_KEY[type]]: record, ...(warnings.length > 0 ? { warnings } : {}) },
            1
          );
        }

        let matches = data;
        if (args.query !== undefined) {
          const query = args.query;
          matches = matches.filter((record) => matchesText(query, ...kind.searchText(record)));
        }
        if (args.conditions !== undefined && args.conditions.length > 0) {
          matches = applyConditions(matches, kind.fields, args.conditions);
        }

        const pagination = resolvePagination(
          args.page,
          args.pageSize,
          allFields ? FIELD_HEAVY_PAGE_SIZE : DEFAULT_PAGE_SIZE
        );
        assertResultSetFits(matches.length, deps.config, kind.narrowHint);

        const page = paginate(matches, pagination, warnings);

        // The "populated but constant" fold, for the types that have an open
        // field map. This is exactly the case docs/known-limitations.md found
        // ("115 fields populated, only 36 varied") — folded here so a
        // full-detail listing pays for it once per response, not once per row.
        const openFields = kind.openFields;
        const withOpenFields = kind.withOpenFields;
        if (openFields === undefined || withOpenFields === undefined) {
          return fromPage(page, { ...(args.query === undefined ? {} : { query: args.query }) });
        }

        const folded = foldUniformFields(page.items, openFields, withOpenFields);
        const uniformCount = Object.keys(folded.uniformFields).length;
        if (uniformCount > 0) {
          page.warnings = [
            ...(page.warnings ?? []),
            uniformFieldsNote(uniformCount, folded.foldedOccurrences, kind.label),
          ];
        }

        return fromPage(
          { ...page, items: folded.records },
          {
            ...(args.query === undefined ? {} : { query: args.query }),
            ...(uniformCount > 0 ? { uniformFields: folded.uniformFields } : {}),
          }
        );
      })
  );
}
