import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildImportRequest, ledgerMessage, type LedgerFields } from '../../tally/requests/import.js';
import { companySchema } from '../../schemas/common.js';
import { TallyError } from '../../tally/TallyError.js';
import { runTool, type ToolDeps } from '../shared/toolResult.js';
import {
  amountSchema,
  conflict,
  currentGroups,
  currentLedgers,
  describeSigned,
  findExisting,
  masterNameSchema,
  requireAbsent,
  requireExisting,
  sideSchema,
  toTallySigned,
  writeTargetCompany,
} from '../shared/writeInputs.js';
import { previewResult, WRITE_NOTICE } from '../confirm/flow.js';
import { booksBegin, ledgerDetailsShape } from '../create/ledger.js';
import {
  currentDetailsView,
  detailMismatches,
  planDetails,
  readLedgerDetails,
} from '../shared/ledgerDetails.js';

/**
 * tally_alter_ledger — change an existing ledger. Only the fields given change.
 */
export function registerAlterLedgerTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_alter_ledger',
    {
      description:
        'Change an EXISTING ledger in TallyPrime: rename it, move it to another group, change its ' +
        'opening balance, or update its party details. Only the fields you give are changed.\n\n' +
        'The preview shows each changed field before and after. Renaming or regrouping a ledger ' +
        'changes how every voucher already posted to it is reported.\n\n' +
        WRITE_NOTICE,
      inputSchema: z.object({
        company: companySchema,
        name: masterNameSchema.describe('The ledger to change, by its current name.'),
        newName: masterNameSchema.optional().describe('Rename it to this.'),
        group: masterNameSchema.optional().describe('Move it under this existing group.'),
        openingBalance: amountSchema.optional(),
        openingSide: sideSchema.optional().describe('Required with openingBalance.'),
        ...ledgerDetailsShape,
      }),
    },
    async (input) =>
      runTool('tally_alter_ledger', deps, async () => {
        if ((input.openingBalance === undefined) !== (input.openingSide === undefined)) {
          throw new TallyError('INVALID_PARAMETERS', 'Give openingBalance and openingSide together, or neither.');
        }

        const company = await writeTargetCompany(deps, input.company);
        const ledgers = await currentLedgers(deps, company);
        const ledger = requireExisting(ledgers, input.name, (l) => l.name, 'ledger');

        const changes: Record<string, { from: unknown; to: unknown }> = {};
        const currentDetails = await readLedgerDetails(deps, company, ledger.name);
        const details = planDetails(input, currentDetails, await booksBegin(deps, company));
        const fields: LedgerFields = { ...details };
        const was = currentDetailsView(currentDetails);
        for (const key of ['email', 'incomeTaxNumber', 'gstin', 'isBillWiseOn'] as const) {
          if (details[key] !== undefined && details[key] !== was[key]) {
            changes[key] = { from: was[key], to: details[key] };
          }
        }
        if (details.mailing !== undefined) {
          for (const key of ['mailingName', 'address', 'state', 'country', 'pincode'] as const) {
            if (JSON.stringify(details.mailing[key]) !== JSON.stringify(was[key])) {
              changes[key] = { from: was[key], to: details.mailing[key] };
            }
          }
        }

        if (input.newName !== undefined && input.newName !== ledger.name) {
          if (input.newName.toLowerCase() !== ledger.name.toLowerCase()) {
            requireAbsent(ledgers, input.newName, (l) => l.name, 'ledger');
          }
          fields.rename = input.newName;
          changes.name = { from: ledger.name, to: input.newName };
        }
        if (input.group !== undefined) {
          const group = requireExisting(await currentGroups(deps, company), input.group, (g) => g.name, 'group');
          if (group.name !== ledger.parent) {
            fields.parent = group.name;
            changes.group = { from: ledger.parent, to: group.name };
          }
        }
        if (input.openingBalance !== undefined && input.openingSide !== undefined) {
          const opening = toTallySigned(input.openingBalance, input.openingSide);
          fields.openingBalance = opening;
          changes.openingBalance = {
            from: describeSigned(ledger.openingBalance?.amount),
            to: describeSigned(opening),
          };
        }

        if (Object.keys(changes).length === 0) {
          throw new TallyError('INVALID_PARAMETERS', `Nothing to change: no field differs from "${ledger.name}" as it is.`);
        }

        const before = {
          name: ledger.name,
          group: ledger.parent,
          openingBalance: ledger.openingBalance?.amount ?? null,
        };
        const finalName = fields.rename ?? ledger.name;

        return previewResult(deps, {
          tool: 'tally_alter_ledger',
          company,
          summary: `Alter ledger "${ledger.name}": ${Object.keys(changes).join(', ')}.`,
          preview: {
            action: 'ALTER LEDGER',
            ledger: ledger.name,
            changes,
            closingBalanceNow: describeSigned(ledger.closingBalance?.amount),
          },
          body: buildImportRequest('All Masters', company, [ledgerMessage('Alter', ledger.name, fields)]),
          expect: { altered: 1 },
          recheck: async (d) => {
            const now = findExisting(await currentLedgers(d, company), ledger.name, (l) => l.name);
            if (
              now === undefined ||
              now.parent !== before.group ||
              (now.openingBalance?.amount ?? null) !== before.openingBalance
            ) {
              throw conflict(`The ledger "${ledger.name}" was changed in TallyPrime after the preview.`);
            }
          },
          verify: async (d) => {
            const after = findExisting(await currentLedgers(d, company), finalName, (l) => l.name);
            if (after === undefined) return { confirmed: false, detail: `no ledger named "${finalName}" was found` };
            const notLanded =
              Object.keys(details).length === 0
                ? []
                : detailMismatches(details, await readLedgerDetails(d, company, finalName));
            const confirmed =
              (fields.parent === undefined || after.parent === fields.parent) &&
              (fields.openingBalance === undefined ||
                describeSigned(after.openingBalance?.amount) === describeSigned(fields.openingBalance)) &&
              notLanded.length === 0;
            return {
              confirmed,
              detail: {
                ledger: after.name,
                group: after.parent,
                openingBalance: describeSigned(after.openingBalance?.amount),
                ...(notLanded.length > 0 ? { detailsNotStored: notLanded } : {}),
              },
            };
          },
          undo:
            `Alter it back with tally_alter_ledger (name "${finalName}") to: name "${before.name}", ` +
            `group "${String(before.group)}", opening ${describeSigned(before.openingBalance)}.`,
        });
      })
  );
}
