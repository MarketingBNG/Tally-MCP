import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildImportRequest, voucherAlterMessage } from '../../tally/requests/import.js';
import { companySchema, isoDateSchema } from '../../schemas/common.js';
import { TallyError } from '../../tally/TallyError.js';
import { runTool, type ToolDeps } from '../shared/toolResult.js';
import { conflict, writeTargetCompany } from '../shared/writeInputs.js';
import {
  describeVoucher,
  findVoucher,
  linesMatch,
  headerMismatches,
  missingBills,
  requireVoucher,
  validateVoucher,
  voucherContentShape,
} from '../shared/voucherWrites.js';
import { previewResult, WRITE_NOTICE } from '../confirm/flow.js';

/** How a write names the voucher it acts on — both straight from a read tool's output. */
export const voucherTargetShape = {
  guid: z.string().trim().min(1).describe('The voucher\'s guid, as returned by tally_get_vouchers.'),
  currentDate: isoDateSchema.describe('The voucher\'s date as it is NOW in TallyPrime (from the same read).'),
};

/**
 * tally_alter_voucher — replace an existing voucher's content.
 *
 * Replace, not patch: the voucher after the alter is exactly the content given.
 * That is how TallyPrime's import alter behaves (verified live — entries are
 * replaced, not appended), and stating the whole voucher keeps the preview an
 * exact picture of the result.
 */
export function registerAlterVoucherTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_alter_voucher',
    {
      description:
        'Change an EXISTING voucher in TallyPrime — its lines, amounts, date, narration or reference.\n\n' +
        'Give the voucher\'s guid and current date (from tally_get_vouchers), and the COMPLETE voucher ' +
        'as it should be afterwards: every line, not only the changed ones. The preview shows it ' +
        'before and after.\n\n' +
        'If the voucher was changed or deleted in TallyPrime after the preview, the confirm is refused ' +
        '(TallyPrime would otherwise create a new voucher instead of altering).\n\n' +
        WRITE_NOTICE,
      inputSchema: z.object({ company: companySchema, ...voucherTargetShape, ...voucherContentShape }),
    },
    async (input) =>
      runTool('tally_alter_voucher', deps, async () => {
        const company = await writeTargetCompany(deps, input.company);
        const target = await requireVoucher(deps, company, input.guid, input.currentDate);
        if (target.voucher.isCancelled) {
          throw new TallyError('INVALID_PARAMETERS', 'That voucher is cancelled; a cancelled voucher is not altered.');
        }
        if (target.alterId === null) {
          throw new TallyError('TALLY_INVALID_RESPONSE', 'Could not read the voucher\'s AlterId, so a safe alter is not possible.');
        }

        // Keep the voucher's existing party when the caller does not name one and
        // that ledger is still on it — TallyPrime takes the party from the first
        // line, so re-sending the lines in another order would quietly change it.
        const existingParty = target.voucher.partyLedgerName;
        const keepParty =
          input.partyLedger === undefined &&
          existingParty !== null &&
          input.entries.some((e) => e.ledger.toLowerCase() === existingParty.toLowerCase());
        const validated = await validateVoucher(deps, company, {
          ...input,
          ...(keepParty ? { partyLedger: existingParty } : {}),
        });
        const { content } = validated;
        if (content.voucherType !== target.voucher.voucherType) {
          throw new TallyError(
            'INVALID_PARAMETERS',
            `The voucher is a ${String(target.voucher.voucherType)}; changing its type is not an alter. ` +
              'Cancel it and post a new voucher instead.'
          );
        }
        const voucherNumber = content.voucherNumber ?? target.voucher.voucherNumber ?? undefined;
        const finalContent = { ...content, ...(voucherNumber === undefined ? {} : { voucherNumber }) };
        const { guid } = input;
        const before = describeVoucher(target.voucher);

        return previewResult(deps, {
          tool: 'tally_alter_voucher',
          company,
          summary: `Alter ${String(target.voucher.voucherType)} ${String(target.voucher.voucherNumber)} dated ${input.currentDate}.`,
          preview: {
            action: 'ALTER VOUCHER',
            guid,
            before,
            after: {
              voucherType: finalContent.voucherType,
              date: finalContent.date,
              voucherNumber: finalContent.voucherNumber ?? null,
              narration: finalContent.narration ?? '',
              lines: validated.table,
              total: validated.total,
            },
            ...(validated.warnings.length > 0 ? { warnings: validated.warnings } : {}),
          },
          body: buildImportRequest('Vouchers', company, [
            voucherAlterMessage(target.masterId, input.currentDate, finalContent),
          ]),
          expect: { altered: 1 },
          recheck: async (d) => {
            const now = await findVoucher(d, company, guid, input.currentDate);
            if (now === null) {
              throw conflict('The voucher no longer exists on that date in TallyPrime; altering it would create a new one.');
            }
            if (now.alterId !== target.alterId || now.voucher.isCancelled) {
              throw conflict('The voucher was changed in TallyPrime after the preview.');
            }
          },
          verify: async (d) => {
            const after = await findVoucher(d, company, guid, finalContent.date);
            if (after === null) return { confirmed: false, detail: `voucher ${guid} was not found on ${finalContent.date}` };
            const billsMissing = missingBills(after.voucher, finalContent.lines);
            const headerProblems = headerMismatches(after.voucher, finalContent);
            return {
              confirmed: linesMatch(after.voucher, finalContent.lines) && billsMissing.length === 0 &&
                headerProblems.length === 0,
              detail: {
                guid,
                ...describeVoucher(after.voucher),
                ...(billsMissing.length > 0 ? { billsNotFound: billsMissing } : {}),
                ...(headerProblems.length > 0 ? { headerNotStored: headerProblems } : {}),
              },
            };
          },
          undo: `Alter it back with tally_alter_voucher to the "before" shown in the preview (guid ${guid}).`,
        });
      })
  );
}
