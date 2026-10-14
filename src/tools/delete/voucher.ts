import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildImportRequest, voucherDeleteMessage } from '../../tally/requests/import.js';
import { companySchema } from '../../schemas/common.js';
import { runTool, type ToolDeps } from '../shared/toolResult.js';
import { conflict, writeTargetCompany } from '../shared/writeInputs.js';
import { describeVoucher, findVoucher, requireVoucher } from '../shared/voucherWrites.js';
import { previewResult, WRITE_NOTICE } from '../confirm/flow.js';
import { voucherTargetShape } from '../alter/voucher.js';

/**
 * tally_delete_voucher — remove a voucher from the books entirely.
 */
export function registerDeleteVoucherTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_delete_voucher',
    {
      description:
        'DELETE a voucher from TallyPrime entirely. Its number becomes a gap in the series.\n\n' +
        'Prefer tally_cancel_voucher for a posted entry that has to be voided — cancelling keeps the ' +
        'number and the audit trail. Delete is for entries that should never have existed, such as a ' +
        'duplicate posting.\n\n' +
        'Give the guid and current date from tally_get_vouchers.\n\n' +
        WRITE_NOTICE,
      inputSchema: z.object({ company: companySchema, ...voucherTargetShape }),
    },
    async (input) =>
      runTool('tally_delete_voucher', deps, async () => {
        const company = await writeTargetCompany(deps, input.company);
        const target = await requireVoucher(deps, company, input.guid, input.currentDate);
        const voucherType = target.voucher.voucherType ?? '';
        const { guid, currentDate } = input;
        const before = describeVoucher(target.voucher);

        return previewResult(deps, {
          tool: 'tally_delete_voucher',
          company,
          summary: `Delete ${voucherType} ${String(target.voucher.voucherNumber)} dated ${currentDate}.`,
          preview: {
            action: 'DELETE VOUCHER',
            guid,
            voucher: before,
            effect: 'The voucher is removed entirely and its number becomes a gap in the series.',
          },
          body: buildImportRequest('Vouchers', company, [
            voucherDeleteMessage(target.masterId, currentDate, voucherType),
          ]),
          expect: { deleted: 1 },
          recheck: async (d) => {
            const now = await findVoucher(d, company, guid, currentDate);
            if (now === null) throw conflict('The voucher no longer exists in TallyPrime.');
            if (now.alterId !== target.alterId) throw conflict('The voucher was changed in TallyPrime after the preview.');
          },
          verify: async (d) => {
            const still = await findVoucher(d, company, guid, currentDate);
            return {
              confirmed: still === null,
              detail: still === null ? `voucher ${guid} is gone` : `voucher ${guid} is still present`,
            };
          },
          undo: 'Re-post it with tally_create_voucher using the lines shown in this preview (it gets a new number).',
        });
      })
  );
}
