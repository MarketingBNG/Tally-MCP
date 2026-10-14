import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildImportRequest, ledgerMessage } from '../../tally/requests/import.js';
import { companySchema } from '../../schemas/common.js';
import { runTool, type ToolDeps } from '../shared/toolResult.js';
import {
  conflict,
  currentLedgers,
  describeSigned,
  findExisting,
  masterNameSchema,
  requireExisting,
  writeTargetCompany,
} from '../shared/writeInputs.js';
import { previewResult, WRITE_NOTICE } from '../confirm/flow.js';

/**
 * tally_delete_ledger — remove a ledger from the chart of accounts.
 *
 * TallyPrime itself refuses to delete a ledger that has vouchers posted to it,
 * so this cannot erase history; it can only remove an unused account.
 */
export function registerDeleteLedgerTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_delete_ledger',
    {
      description:
        'Delete a ledger from TallyPrime.\n\n' +
        'WHEN TO USE: to remove an account created by mistake or no longer used. TallyPrime ' +
        'refuses to delete a ledger that has vouchers posted to it — that refusal is reported as ' +
        'WRITE_REJECTED and nothing is changed.\n\n' +
        WRITE_NOTICE,
      inputSchema: z.object({
        company: companySchema,
        name: masterNameSchema.describe('The ledger to delete, by its exact name.'),
      }),
    },
    async (input) =>
      runTool('tally_delete_ledger', deps, async () => {
        const company = await writeTargetCompany(deps, input.company);
        const ledger = requireExisting(await currentLedgers(deps, company), input.name, (l) => l.name, 'ledger');

        return previewResult(deps, {
          tool: 'tally_delete_ledger',
          company,
          summary: `Delete ledger "${ledger.name}" (group "${String(ledger.parent)}").`,
          preview: {
            action: 'DELETE LEDGER',
            ledger: ledger.name,
            group: ledger.parent,
            openingBalance: describeSigned(ledger.openingBalance?.amount),
            closingBalance: describeSigned(ledger.closingBalance?.amount),
            note: 'TallyPrime will refuse this if any voucher is posted to the ledger.',
          },
          body: buildImportRequest('All Masters', company, [ledgerMessage('Delete', ledger.name)]),
          expect: { deleted: 1 },
          recheck: async (d) => {
            if (findExisting(await currentLedgers(d, company), ledger.name, (l) => l.name) === undefined) {
              throw conflict(`The ledger "${ledger.name}" no longer exists in TallyPrime.`);
            }
          },
          verify: async (d) => {
            const still = findExisting(await currentLedgers(d, company), ledger.name, (l) => l.name);
            return {
              confirmed: still === undefined,
              detail: still === undefined ? `"${ledger.name}" is gone` : `"${ledger.name}" is still present`,
            };
          },
          undo:
            `Recreate it with tally_create_ledger: name "${ledger.name}", group "${String(ledger.parent)}", ` +
            `opening ${describeSigned(ledger.openingBalance?.amount)} (party details are not restored).`,
        });
      })
  );
}
