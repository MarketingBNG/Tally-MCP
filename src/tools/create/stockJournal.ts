import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { groupKey } from '../../model/groupTree.js';
import { buildImportRequest, stockJournalCreateMessage } from '../../tally/requests/import.js';
import { companySchema, isoDateSchema } from '../../schemas/common.js';
import { TallyError } from '../../tally/TallyError.js';
import { fetchVoucherTypes } from '../read/voucherTypes.js';
import { runTool, type ToolDeps } from '../shared/toolResult.js';
import { requireExisting, writeTargetCompany } from '../shared/writeInputs.js';
import {
  assertDateInBooks,
  describeVoucher,
  findVoucherByMasterId,
  headerMismatches,
} from '../shared/voucherWrites.js';
import {
  readLineMasters,
  resolveStockLines,
  stockJournalMatches,
  stockLineSchema,
} from '../shared/voucherLines.js';
import { previewResult, WRITE_NOTICE } from '../confirm/flow.js';

/**
 * tally_create_stock_journal — move stock without touching the accounts:
 * transfers between godowns, consumption into production, adjustments.
 */
export function registerCreateStockJournalTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_create_stock_journal',
    {
      description:
        'Post a NEW stock journal in TallyPrime: stock that goes OUT (consumed) and stock that comes ' +
        'IN (produced or received), with no ledger lines. Use it to transfer stock between godowns ' +
        '(same item out of one godown, into another), to record production (raw materials out, ' +
        'finished goods in), or to adjust stock.\n\n' +
        'Each line is a stock item, quantity, rate and godown. The value of each line is quantity × ' +
        'rate. For a sale or purchase of items use tally_create_voucher with `items`.\n\n' +
        WRITE_NOTICE,
      inputSchema: z.object({
        company: companySchema,
        voucherType: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Default "Stock Journal". A custom type must be based on Stock Journal.'),
        date: isoDateSchema.describe('Voucher date, ISO YYYY-MM-DD.'),
        consumed: z.array(stockLineSchema).min(1).max(200).describe('Stock going OUT.'),
        produced: z.array(stockLineSchema).min(1).max(200).describe('Stock coming IN.'),
        narration: z.string().max(2000).optional(),
        voucherNumber: z
          .string()
          .max(50)
          .optional()
          .describe('Only for types numbered manually. Omit to let TallyPrime number it.'),
      }),
    },
    async (input) =>
      runTool('tally_create_stock_journal', deps, async () => {
        const company = await writeTargetCompany(deps, input.company);
        const types = (await fetchVoucherTypes(deps, company)).voucherTypes;
        const type = requireExisting(types, input.voucherType ?? 'Stock Journal', (t) => t.name, 'voucher type');
        if (groupKey(type.parent ?? type.name) !== 'stock journal') {
          throw new TallyError('INVALID_PARAMETERS', `"${type.name}" is not a stock journal type.`);
        }
        await assertDateInBooks(deps, company, input.date);

        const masters = await readLineMasters(deps, company, { items: true, costCentres: false });
        const out = resolveStockLines(masters, input.consumed, 'Consumed');
        const into = resolveStockLines(masters, input.produced, 'Produced');
        const warnings: string[] = [];
        if (!out.total.equals(into.total)) {
          warnings.push(
            `Stock going out is valued at ${out.total.toFixed(2)} and stock coming in at ` +
              `${into.total.toFixed(2)}. That is normal for production at a different cost, but for a ` +
              'plain transfer between godowns the two should match.'
          );
        }
        const content = {
          voucherType: type.name,
          date: input.date,
          consumed: out.lines,
          produced: into.lines,
          ...(input.narration === undefined ? {} : { narration: input.narration }),
          ...(input.voucherNumber === undefined ? {} : { voucherNumber: input.voucherNumber }),
        };
        const show = (lines: typeof out.lines): Record<string, string>[] =>
          lines.map((l) => ({
            item: l.item,
            quantity: `${l.quantity} ${l.unit}`,
            rate: l.rate,
            value: l.amount,
            ...(l.godown === undefined ? {} : { godown: l.godown }),
          }));

        return previewResult(deps, {
          tool: 'tally_create_stock_journal',
          company,
          summary: `Post a ${type.name} dated ${input.date}: ${String(out.lines.length)} line(s) out, ${String(into.lines.length)} in.`,
          preview: {
            action: 'CREATE STOCK JOURNAL',
            voucherType: type.name,
            date: input.date,
            narration: input.narration ?? '',
            consumed: show(out.lines),
            produced: show(into.lines),
            ...(warnings.length > 0 ? { warnings } : {}),
          },
          body: buildImportRequest('Vouchers', company, [stockJournalCreateMessage(content)]),
          expect: { created: 1 },
          recheck: () => Promise.resolve(),
          verify: async (d, counters) => {
            const masterId = counters?.lastVoucherId ?? 0;
            if (masterId <= 0) return { confirmed: false, detail: 'TallyPrime did not report the new voucher\'s MasterId.' };
            const made = await findVoucherByMasterId(d, company, masterId, input.date);
            if (made === null) return { confirmed: false, detail: `voucher MasterId ${String(masterId)} was not found on ${input.date}` };
            const headerProblems = headerMismatches(made, { ...content, lines: [] });
            return {
              confirmed:
                stockJournalMatches(made, out.lines, into.lines) &&
                made.voucherType === type.name &&
                headerProblems.length === 0,
              detail: {
                guid: made.guid,
                masterId,
                ...describeVoucher(made),
                ...(headerProblems.length > 0 ? { headerNotStored: headerProblems } : {}),
              },
            };
          },
          undo:
            'Cancel it with tally_cancel_voucher or remove it with tally_delete_voucher, using the guid ' +
            'and date in the read-back.',
        });
      })
  );
}
