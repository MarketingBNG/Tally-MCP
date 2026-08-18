import { z } from 'zod';
import { Decimal } from 'decimal.js';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  buildGodownSummaryRequest,
  buildStockSummaryRequest,
  UNSCOPED,
  type TallyRequestOptions,
} from '../tally/requests.js';
import {
  normalizeClosingStock,
  type ClosingStockRow,
  type Normalized,
} from '../tally/normalize.js';
import { companySchema, READ_ONLY_NOTICE, UNTRUSTED_CONTENT_NOTICE } from '../schemas/common.js';
import {
  assertCompanyIsLoaded,
  resolveCompanyCurrency,
  runTool,
  whole,
  type ToolDeps,
} from './toolResult.js';

/**
 * `tally_get_closing_stock`: closing stock by item, or by location.
 *
 * ## Why this exists at all, and why it took so long
 *
 * `Stock Summary` and `Godown Summary` are two of six report IDs that were
 * confirmed VALID on 2026-08-10 — TallyPrime accepted them rather than replying
 * with `<LINEERROR>` — and yet returned a bare `<ENVELOPE></ENVELOPE>` on every
 * company available. A valid report with no response shape cannot be parsed, so
 * `tally_get_report` sat parked in docs/next-steps.md for exactly this reason:
 * building it would have shipped a tool nobody could verify end to end.
 *
 * On 2026-08-14 a company that maintains inventory finally populated both, and
 * this is the result. The other four (`Cost Centre Summary`, `Bills Receivable`,
 * `Bills Payable`, `Ledger Vouchers`) still return nothing and are still
 * unbuilt — three companies in a row have used neither cost centres nor
 * bill-wise billing.
 *
 * ## Why a narrow tool rather than the generic escape hatch
 *
 * next-steps.md item 1 describes `tally_get_report`: one tool taking an
 * allowlisted report ID. With exactly two verified IDs, both returning the SAME
 * shape, a generic wrapper would be a two-entry enum wearing a general-purpose
 * name — it would advertise coverage that does not exist and invite a caller to
 * guess an ID, which is the habit the allowlist exists to prevent. So this tool
 * is named for what it actually answers. When a third report with a genuinely
 * different shape is verified, THAT is the point to reconsider a generic one.
 *
 * The report ID never comes from the model: `by` is a two-value enum mapped to a
 * builder here. There is no path from tool input to an arbitrary report name.
 *
 * ## The relationship to tally_get_masters type "stockItem", which matters
 *
 * `tally_get_masters type "stockItem"` reads closing quantity and value from the stock item
 * MASTERS; this reads TallyPrime's own Stock Summary REPORT. They are two bases
 * for the same question, and this codebase has already been bitten once by
 * assuming two such paths agree — see the trial-balance-versus-masters
 * divergence in reports.ts, where Tally's trial balance carries stock at its
 * OPENING value while the masters carry the closing one, a 20% difference of
 * entirely plausible size. Neither figure is adjusted here and no cross-check is
 * run (it would cost a second full fetch); the description tells the caller
 * which basis it is holding and to say so.
 */

/** The two verified reports. The ID is chosen here, never supplied by a caller. */
const REPORTS = {
  item: {
    build: buildStockSummaryRequest,
    reportName: 'stock summary',
    entityKind: 'stockItem' as const,
    rowLabel: 'stock item',
  },
  godown: {
    build: buildGodownSummaryRequest,
    reportName: 'godown summary',
    entityKind: 'godown' as const,
    rowLabel: 'godown (location)',
  },
} satisfies Record<
  string,
  {
    // NOT optional. An `options?` here would let a report be fetched with no
    // company scope at all through this indirection, which is the hole that
    // produced the cross-company cache hit one layer up, pinned in
    // tests/tools/companyScoping.test.ts. See CompanyScope in requests.ts.
    build: (options: TallyRequestOptions) => string;
    reportName: string;
    entityKind: 'stockItem' | 'godown';
    rowLabel: string;
  }
>;

const bySchema = z
  .enum(['item', 'godown'])
  .describe(
    "Group closing stock by 'item' (one row per stock item, from TallyPrime's Stock Summary) or " +
      "by 'godown' (one row per storage location, from its Godown Summary). Two different " +
      'reports; not two views of one fetch.'
  );

const DESCRIPTION = [
  "Closing stock from TallyPrime's own summary reports: quantity, rate and value per stock item, " +
    'or per godown (storage location).',
  '',
  "WHEN TO USE: for what stock is on hand and what it is carried at. `by: 'godown'` is the only " +
    'way to get location-wise stock in this server — use it for questions about where stock sits, ' +
    'or to check one warehouse against another.',
  '',
  'RETURNS: one row per item or godown with name, closingQuantity, closingRate and closingValue. ' +
    'No period is taken: these reports give the CLOSING position as TallyPrime currently reports ' +
    'it, not movement over a range. For movement use tally_get_inventory_movements.',
  '',
  'QUANTITY IS A STRING WITH ITS UNIT — "9500.00 Kg" — passed through exactly as Tally formats ' +
    'it, because a bare stock number without its unit is meaningless. Quote it with the unit.',
  '',
  'DO NOT MULTIPLY QUANTITY BY RATE. closingRate is rounded to the displayed decimals, so the ' +
    'product disagrees with the real value: verified live, an item at 9500.00 Kg and rate 4.85 ' +
    'carries a Tally value of 46,084.41, where 9500 x 4.85 is 46,075.00. closingValue is ' +
    "TallyPrime's own figure — use it, and never recompute it.",
  '',
  'SIGNS: closingValue arrives NEGATIVE for stock in hand, because Tally encodes debit balances ' +
    'negatively and stock is an asset. That matches the trial balance convention and is preserved, ' +
    'never corrected. Report the magnitude and say it is stock held — do not describe stock as ' +
    'having a negative value. A null value is Tally reporting nothing, which is NOT a zero.',
  '',
  'TWO BASES FOR ONE QUESTION — say which you are quoting. tally_get_masters type "stockItem" reads the same ' +
    'figures from the stock item MASTERS; this reads the summary REPORT. They usually agree, but ' +
    'TallyPrime is known to carry stock on different bases in different reports (its trial balance ' +
    'uses the OPENING value while the masters use the closing one). Nothing here is adjusted to ' +
    'make them match. If a figure matters, state that it came from the Stock Summary report.',
  '',
  'EMPTY RESULT: a company that does not maintain inventory gets zero rows. That means the ' +
    'feature is unused, NOT that stock is nil — do not report it as zero stock.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

/**
 * Total closing stock value per TallyPrime's own Stock Summary, or null.
 *
 * Exists so `profit_loss` can check its stock line against the report that
 * carries the CLOSING position, rather than leaving the caller to notice the
 * difference by running two tools and subtracting. See noteStaleClosingStock
 * in reports.ts for why that check is worth a request.
 *
 * SIGNS ARE PRESERVED. `closingValue` arrives negative for stock in hand and is
 * summed as it arrives — the comparison in reports.ts is made on magnitudes, so
 * nothing here needs to normalise a sign it would only get wrong.
 *
 * A null closingValue is Tally reporting nothing, which is NOT a zero, so a row
 * carrying one makes the total unusable rather than merely smaller: the caller
 * gets null and says nothing, instead of comparing against a figure that is
 * short by an unknown amount.
 *
 * Never throws. This backs a diagnostic, and a diagnostic that turns a correct
 * statement into an error is worse than the inconsistency it reports.
 */
export async function fetchClosingStockTotal(
  deps: ToolDeps,
  company: string | undefined
): Promise<Decimal | null> {
  try {
    const scope = await assertCompanyIsLoaded(deps, company);
    const response = await deps.client.send(
      REPORTS.item.build({ company: scope ?? UNSCOPED }),
      'report'
    );
    const { data }: Normalized<ClosingStockRow[]> = normalizeClosingStock(
      response.body,
      REPORTS.item.reportName,
      REPORTS.item.entityKind,
      // No currency label: this total is compared against another figure and
      // never shown, so resolving one would spend a request to decorate a
      // number nobody reads.
      undefined
    );
    if (data.length === 0) return null;

    let total = new Decimal(0);
    for (const row of data) {
      const amount = row.closingValue?.amount;
      if (amount === undefined || amount === null) return null;
      total = total.plus(new Decimal(amount));
    }
    return total;
  } catch {
    return null;
  }
}

export function registerClosingStockTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_get_closing_stock',
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        by: bySchema,
        company: companySchema,
      }),
    },
    async (args) =>
      runTool('tally_get_closing_stock', deps, async () => {
        const spec = REPORTS[args.by];
        // Tally’s own spelling, not the caller’s — see assertCompanyIsLoaded.
        const company = await assertCompanyIsLoaded(deps, args.company);

        const currencyWarnings: string[] = [];
        const currency = await resolveCompanyCurrency(deps, company, currencyWarnings);

        const response = await deps.client.send(
          spec.build({ company: company ?? UNSCOPED }),
          // Report-class: these get the longer timeout, like the statements.
          'report'
        );

        const { data, warnings }: Normalized<ClosingStockRow[]> = normalizeClosingStock(
          response.body,
          spec.reportName,
          spec.entityKind,
          currency
        );

        // Said explicitly rather than left for the caller to infer from a zero
        // row count, which reads identically to "the stock is nil".
        const emptyNote =
          data.length === 0
            ? [
                `TallyPrime returned no rows for its ${spec.reportName}. The report is valid, so ` +
                  'this means the loaded company does not maintain inventory (or, for godowns, ' +
                  'records no stock against any location) — it does NOT mean stock is zero. Do ' +
                  'not report a nil stock position on the strength of this.',
              ]
            : [];

        const allWarnings = [
          ...response.repairs,
          ...currencyWarnings,
          ...warnings,
          ...emptyNote,
        ];

        return whole(
          {
            basis: `TallyPrime ${spec.reportName} report`,
            groupedBy: spec.rowLabel,
            ...(args.company === undefined ? {} : { company: args.company }),
            rows: data,
            ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
          },
          data.length
        );
      })
  );
}
