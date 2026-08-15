import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildStockItemListRequest } from '../tally/requests.js';
import { normalizeStockItems, type StockItem } from '../tally/normalize.js';
import { fetchVouchers } from './vouchers.js';
import {
  companySchema,
  dateRangeSchema,
  paginationSchema,
  PERIOD_NOTE,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import { FIELD_HEAVY_PAGE_SIZE, paginate, resolvePagination } from '../utils/pagination.js';
import { foldUniformFields, uniformFieldsNote } from '../utils/uniformFields.js';
import {
  assertResultSetFits,
  fetchCollection,
  fromPage,
  noteEmptyDefaultedPeriod,
  periodWasDefaulted,
  resolvePeriodForCompany,
  runTool,
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
        const period = await resolvePeriodForCompany(deps, args.fromDate, args.toDate, args.company);

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

        /**
         * Vouchers excluded from the movement list, and vouchers merely flagged.
         *
         * Every one of these carries inventory lines, so before this they all
         * appeared as real stock movements:
         *
         * - CANCELLED: posts nothing at all. Nothing was excluded here before,
         *   which is the same omission the movement-based tools were fixed for.
         * - ORDER vouchers: a sales or purchase ORDER carries stock lines for
         *   goods that have not moved. It is a commitment, so counting it as a
         *   movement overstates what left or entered the warehouse.
         * - INVENTORY-ONLY vouchers (delivery and receipt notes): these are real
         *   movements, so they are NOT excluded. But the invoice that follows a
         *   receipt note carries lines for the same goods, so a period holding
         *   both double-counts. Whether to net them is an accounting judgement,
         *   which this tool reports rather than makes.
         */
        let excludedCancelled = 0;
        let excludedOrders = 0;
        let inventoryOnlyVouchers = 0;

        for (const voucher of vouchers) {
          if (voucher.isCancelled) {
            excludedCancelled += 1;
            continue;
          }
          if (voucher.isOrderVoucher) {
            excludedOrders += 1;
            continue;
          }
          let matchedThisVoucher = false;

          for (const tag of INVENTORY_LIST_TAGS) {
            for (const line of voucher.nested?.[tag] ?? []) {
              const itemName = line.fields.STOCKITEMNAME ?? '';
              if (needle !== undefined && !itemName.toLowerCase().includes(needle)) continue;

              matchedThisVoucher = true;
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

          // Counted only when a line from this voucher actually made it into
          // the returned set — a stock-only voucher for an item the caller
          // didn't ask about must not trigger the double-counting warning.
          if (voucher.isInventoryVoucher && matchedThisVoucher) inventoryOnlyVouchers += 1;
        }

        if (excludedCancelled > 0) {
          warnings.push(
            `${String(excludedCancelled)} cancelled voucher(s) were excluded. A cancelled voucher posts nothing, so its stock lines are not movements.`
          );
        }
        if (excludedOrders > 0) {
          warnings.push(
            `${String(excludedOrders)} order voucher(s) were excluded. A sales or purchase ORDER carries stock lines for goods that have not moved — it is a commitment, not a movement. Ask for vouchers of that type directly if you want the order book.`
          );
        }
        if (inventoryOnlyVouchers > 0) {
          warnings.push(
            `${String(inventoryOnlyVouchers)} voucher(s) here are stock-only (delivery or receipt notes). They ARE included, because the goods did move. But the invoice raised against such a note carries lines for the SAME goods, so if this period contains both, the quantity appears twice. Netting them is an accounting judgement this tool does not make — check whether the note and its invoice both fall in your period before totalling.`
          );
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
        const periodNote = await noteEmptyDefaultedPeriod(deps, period, periodWasDefaulted(args.fromDate, args.toDate), vouchers.length, args.company);

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
