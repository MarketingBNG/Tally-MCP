import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildStockItemListRequest } from '../tally/requests.js';
import { normalizeStockItems, type StockItem } from '../tally/normalize.js';
import { fetchVouchers } from './vouchers.js';
import { TallyError } from '../tally/TallyError.js';
import {
  allFieldsSchema,
  companySchema,
  conditionsSchema,
  dateRangeSchema,
  nameSchema,
  paginationSchema,
  PERIOD_NOTE,
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
  fetchCollection,
  findByName,
  fromPage,
  noteEmptyDefaultedPeriod,
  periodWasDefaulted,
  resolvePeriod,
  runTool,
  whole,
  type DatasetSpec,
  type ToolDeps,
} from './toolResult.js';

/**
 * Inventory tools.
 *
 * Verified live against a company that actually holds stock: name, parent,
 * base unit, opening/closing balance and value, and closing rate are all
 * confirmed and promoted to named properties. Everything else Tally reports
 * (e.g. CATEGORY) still comes through the open `fields` map, since which
 * extra fields exist depends on company configuration.
 */

const UNVERIFIED_NOTICE =
  'Name, parent group, base unit, opening/closing balance and value, and closing rate are ' +
  'returned as named properties, verified against live inventory data. Every other value ' +
  'appears under "fields" with TallyPrime own field names rather than being renamed. If this ' +
  'returns nothing, first check whether the company keeps inventory at all — tally_get_company ' +
  'reports the ledger and group structure.';

/**
 * Verified fields only: every other stock item field lives in the open
 * `fields` map, whose keys vary by company and are not a fixed allowlist
 * this tool can safely expose conditions filtering over.
 */
const STOCK_ITEM_FIELDS: DatasetSpec<StockItem> = {
  name: { type: 'string', get: (s) => s.name },
  parent: { type: 'string', get: (s) => s.parent },
  closingValue: { type: 'money', get: (s) => s.closingValue },
  openingValue: { type: 'money', get: (s) => s.openingValue },
};

const ITEMS_DESCRIPTION = [
  'Stock items: list, search, fetch one by exact name, or filter by name/parent conditions — ' +
    'one call, one mode, picked by which parameters are given.',
  '',
  'WHEN TO USE: to see what inventory the company holds. Returns nothing for a company that ' +
    'does not keep stock, which is a real answer rather than an error.',
  '',
  'MODES:',
  '- name given: fetch that one item, with every field TallyPrime holds for it. Fails with ' +
    'TALLY_COMPANY_NOT_FOUND naming the item, so a typo is distinguishable from an item with ' +
    'no stock.',
  '- query given (no name): case-insensitive substring against the item name and its parent group.',
  '- conditions given: combine name, parent, openingValue and closingValue conditions. Every ' +
    'other stock item field lives in the open "fields" map and is not filterable here — fetch ' +
    'by name for full detail on one item.',
  '- none given: list every item, with their closing balance and value.',
  '',
  UNVERIFIED_NOTICE,
  '',
  'COST/PAGINATION: client-side over a full fetch, in every mode. A small pageSize does not ' +
    'make the call cheap.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

const MOVEMENTS_DESCRIPTION = [
  'Movements of a stock item over a period, taken from the inventory lines on vouchers.',
  '',
  'WHEN TO USE: to see what happened to an item — what came in, what went out, on which ' +
    'voucher and against which party.',
  '',
  'HOW IT IS BUILT: derived from the inventory allocations nested on vouchers in the period, ' +
    'not from a dedicated TallyPrime inventory report. TallyPrime stock movement report ID is ' +
    'not confirmed, and guessing a report ID can terminate the application, so the verified ' +
    'voucher path is used instead. Each movement therefore carries the voucher it came from.',
  '',
  'NO COMPUTED QUANTITIES: quantities and rates are returned exactly as Tally recorded them on ' +
    'each line, in Tally own format (which includes the unit, e.g. "100 nos"). Nothing is ' +
    'summed or converted between units, because unit conversion needs the item conversion ' +
    'factors and getting that wrong silently would be worse than not doing it.',
  '',
  PERIOD_NOTE,
  '',
  UNVERIFIED_NOTICE,
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

/** Inventory-line structures Tally nests on a voucher. */
const INVENTORY_LIST_TAGS = ['ALLINVENTORYENTRIES.LIST', 'INVENTORYENTRIES.LIST'];

/** One full fetch of the stock item collection, shared by all three tools. */
export async function fetchStockItems(
  deps: ToolDeps,
  company: string | undefined,
  allFields: boolean
): Promise<{ items: StockItem[]; warnings: string[] }> {
  const { data, warnings } = await fetchCollection<StockItem>(deps, company, {
    build: (options) => buildStockItemListRequest(options, allFields),
    normalize: normalizeStockItems,
    timeoutClass: allFields ? 'report' : 'standard',
  });

  return { items: data, warnings };
}

export function registerInventoryTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_get_stock_items',
    {
      description: ITEMS_DESCRIPTION,
      inputSchema: z.object({
        name: nameSchema,
        query: querySchema,
        conditions: conditionsSchema,
        company: companySchema,
        includeAllFields: allFieldsSchema,
        ...paginationSchema,
      }),
    },
    async (args) =>
      runTool('tally_get_stock_items', deps, async () => {
        // Full detail by default when fetching one item — that is normally
        // an investigation, and the whole record is what makes it answerable.
        const allFields = args.includeAllFields ?? args.name !== undefined;
        const { items, warnings } = await fetchStockItems(deps, args.company, allFields);

        if (args.name !== undefined) {
          const item = findByName(items, args.name, (candidate) => candidate.name);
          if (item === undefined) {
            throw new TallyError(
              'TALLY_COMPANY_NOT_FOUND',
              `No stock item named "${args.name}" exists in the loaded company.`,
              {
                suggestion:
                  items.length === 0
                    ? 'This company reports no stock items at all — it may not keep inventory.'
                    : 'Check the spelling, or call this tool with a `query` fragment to find it by name.',
              }
            );
          }
          return whole({ item, ...(warnings.length > 0 ? { warnings } : {}) }, 1);
        }

        let matches = items;
        if (args.query !== undefined) {
          matches = matches.filter((item) =>
            matchesText(args.query as string, item.name, item.parent)
          );
        }
        if (args.conditions !== undefined && args.conditions.length > 0) {
          matches = applyConditions(matches, STOCK_ITEM_FIELDS, args.conditions);
        }

        const pagination = resolvePagination(
          args.page,
          args.pageSize,
          allFields ? FIELD_HEAVY_PAGE_SIZE : DEFAULT_PAGE_SIZE
        );
        assertResultSetFits(
          matches.length,
          deps.config,
          'Add a name/query/conditions filter to narrow.'
        );

        const itemsPage = paginate(matches, pagination, warnings);
        // Same "populated but constant" pattern as vouchers and ledgers.
        const itemsFolded = foldUniformFields(
          itemsPage.items,
          (item) => item.fields,
          (item, fields) => ({ ...item, fields })
        );
        if (Object.keys(itemsFolded.uniformFields).length > 0) {
          itemsPage.warnings = [
            ...(itemsPage.warnings ?? []),
            uniformFieldsNote(
              Object.keys(itemsFolded.uniformFields).length,
              itemsFolded.foldedOccurrences,
              'stock item'
            ),
          ];
        }

        return fromPage(
          { ...itemsPage, items: itemsFolded.records },
          {
            ...(args.query === undefined ? {} : { query: args.query }),
            ...(Object.keys(itemsFolded.uniformFields).length > 0
              ? { uniformFields: itemsFolded.uniformFields }
              : {}),
          }
        );
      })
  );

  server.registerTool(
    'tally_get_inventory_movements',
    {
      description: MOVEMENTS_DESCRIPTION,
      inputSchema: z.object({
        stockItem: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Item name to filter to, matched as a case-insensitive substring. Omit to return ' +
              'every inventory movement in the period.'
          ),
        company: companySchema,
        ...dateRangeSchema,
        ...paginationSchema,
      }),
    },
    async (args) =>
      runTool('tally_get_inventory_movements', deps, async () => {
        // Always field-heavy: inventory lines only exist in nested structures,
        // so this path parses full detail whether or not the caller asked.
        const pagination = resolvePagination(args.page, args.pageSize, FIELD_HEAVY_PAGE_SIZE);
        const period = resolvePeriod(args.fromDate, args.toDate);

        // Inventory lines are nested structures, so full detail is required.
        // Nested only: inventory lines are nested records, not scalar fields.
        const { vouchers, warnings } = await fetchVouchers(
          deps,
          args.company,
          period,
          false,
          true
        );

        const needle = args.stockItem?.toLowerCase();
        const movements: unknown[] = [];

        for (const voucher of vouchers) {
          for (const tag of INVENTORY_LIST_TAGS) {
            for (const line of voucher.nested?.[tag] ?? []) {
              const itemName = line.fields.STOCKITEMNAME ?? '';
              if (needle !== undefined && !itemName.toLowerCase().includes(needle)) continue;

              movements.push({
                stockItem: itemName,
                date: voucher.date,
                voucherNumber: voucher.voucherNumber,
                voucherType: voucher.voucherType,
                partyLedgerName: voucher.partyLedgerName,
                /** Exactly as Tally recorded it, unit included, never converted. */
                fields: line.fields,
                ...(line.nested === undefined ? {} : { nested: line.nested }),
                source: voucher.source,
              });
            }
          }
        }

        assertResultSetFits(
          movements.length,
          deps.config,
          'Narrow the date range, or filter to a single stock item.'
        );

        // Measured at ~30,000 tokens for 50 movements before this — the heaviest
        // call in the server, heavier than full-detail vouchers, because each
        // inventory line carries the whole field map Tally stamps on it and most
        // of those fields hold the same value on every line. Folded after
        // pagination so the claim is about the page returned.
        const page = paginate(movements, pagination, [...warnings]);
        const folded = foldUniformFields(
          page.items as { fields: Record<string, string> }[],
          (row) => row.fields,
          (row, fields) => ({ ...row, fields })
        );
        if (Object.keys(folded.uniformFields).length > 0) {
          page.warnings = [
            ...(page.warnings ?? []),
            uniformFieldsNote(
              Object.keys(folded.uniformFields).length,
              folded.foldedOccurrences,
              'inventory movement'
            ),
          ];
        }

        // Keyed off the vouchers, not the movements: a company with vouchers
        // but no inventory lines is a real answer about inventory, not a
        // period problem.
        const periodNote = await noteEmptyDefaultedPeriod(
          deps,
          period,
          periodWasDefaulted(args.fromDate, args.toDate),
          vouchers.length
        );

        return fromPage(
          {
            ...page,
            items: folded.records,
            warnings: [...periodNote, ...(page.warnings ?? [])],
          },
          {
            period,
            ...(args.stockItem === undefined ? {} : { stockItem: args.stockItem }),
            ...(Object.keys(folded.uniformFields).length > 0
              ? { uniformFields: folded.uniformFields }
              : {}),
          }
        );
      })
  );
}
