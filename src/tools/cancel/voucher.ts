import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildImportRequest, voucherCancelMessage } from '../../tally/requests/import.js';
import { companySchema } from '../../schemas/common.js';
import { TallyError } from '../../tally/TallyError.js';
import { runTool, type ToolDeps } from '../shared/toolResult.js';
import { conflict, writeTargetCompany } from '../shared/writeInputs.js';
import { describeVoucher, findVoucher, requireVoucher } from '../shared/voucherWrites.js';
import { previewResult, WRITE_NOTICE } from '../confirm/flow.js';
import { voucherTargetShape } from '../alter/voucher.js';

/**
 * tally_cancel_voucher — void a voucher while keeping its number in the series.
 *
 * The audit-trail-friendly way to reverse an entry: the number stays, marked
 * cancelled, so the numbering has no gap to explain. Verified live: TallyPrime
 * clears the entries and reports the cancel as ALTERED 1.
 */
export function registerCancelVoucherTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_cancel_voucher',
    {
      description:
        'CANCEL an existing voucher in TallyPrime. It keeps its voucher number, marked cancelled, and ' +
        'its amounts stop counting — so the number series has no gap. Prefer this to deleting when a ' +
        'posted entry has to be voided.\n\n' +
        'Give the guid and current date from tally_get_vouchers, and a reason, which becomes the ' +
        'narration.\n\n' +
        WRITE_NOTICE,
      inputSchema: z.object({
        company: companySchema,
        ...voucherTargetShape,
        reason: z.string().trim().min(1).max(500).describe('Why it is cancelled. Becomes the narration.'),
      }),
    },
    async (input) =>
      runTool('tally_cancel_voucher', deps, async () => {
        const company = await writeTargetCompany(deps, input.company);
        const target = await requireVoucher(deps, company, input.guid, input.currentDate);
        if (target.voucher.isCancelled) {
          throw new TallyError('INVALID_PARAMETERS', 'That voucher is already cancelled.');
        }
        const voucherType = target.voucher.voucherType ?? '';
        const { guid, currentDate } = input;

        return previewResult(deps, {
          tool: 'tally_cancel_voucher',
          company,
          summary: `Cancel ${voucherType} ${String(target.voucher.voucherNumber)} dated ${currentDate}: ${input.reason}`,
          preview: {
            action: 'CANCEL VOUCHER',
            guid,
            voucher: describeVoucher(target.voucher),
            newNarration: input.reason,
            effect: 'The voucher keeps its number, is marked cancelled, and its amounts are removed from every report.',
          },
          body: buildImportRequest('Vouchers', company, [
            voucherCancelMessage(target.masterId, currentDate, voucherType, input.reason),
          ]),
          expect: { altered: 1 },
          recheck: async (d) => {
            const now = await findVoucher(d, company, guid, currentDate);
            if (now === null) throw conflict('The voucher no longer exists in TallyPrime.');
            if (now.alterId !== target.alterId || now.voucher.isCancelled) {
              throw conflict('The voucher was changed in TallyPrime after the preview.');
            }
          },
          verify: async (d) => {
            const after = await findVoucher(d, company, guid, currentDate);
            if (after === null) return { confirmed: false, detail: `voucher ${guid} was not found` };
            return { confirmed: after.voucher.isCancelled, detail: { guid, ...describeVoucher(after.voucher) } };
          },
          undo:
            'A cancelled voucher cannot be un-cancelled through this server. Re-post the original entry ' +
            'with tally_create_voucher, using the lines shown in this preview.',
        });
      })
  );
}
