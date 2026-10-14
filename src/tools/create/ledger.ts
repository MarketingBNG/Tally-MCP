import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildImportRequest, ledgerMessage, type LedgerFields } from '../../tally/requests/import.js';
import { companySchema } from '../../schemas/common.js';
import { companyNamed, runTool, type ToolDeps } from '../shared/toolResult.js';
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
import { detailMismatches, planDetails, readLedgerDetails } from '../shared/ledgerDetails.js';
import { TallyError } from '../../tally/TallyError.js';

/**
 * tally_create_ledger — add a new ledger to the chart of accounts.
 */

/** The optional ledger details, shared with tally_alter_ledger. */
export const ledgerDetailsShape = {
  mailingName: z.string().max(200).optional().describe('Name for letters and statements.'),
  address: z.array(z.string().max(200)).max(5).optional().describe('Address lines, in order.'),
  state: z.string().max(100).optional(),
  country: z.string().max(100).optional(),
  pincode: z.string().max(20).optional().describe('Postal / ZIP code.'),
  email: z.string().max(200).optional(),
  incomeTaxNumber: z.string().max(30).optional().describe('PAN (India) or other income-tax number.'),
  gstin: z.string().max(20).optional().describe('GST registration number of the party.'),
  isBillWiseOn: z
    .boolean()
    .optional()
    .describe('Maintain balances bill-by-bill. Usually true for customers and suppliers.'),
};

export function registerCreateLedgerTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_create_ledger',
    {
      description:
        'Create a NEW ledger in TallyPrime under an existing group.\n\n' +
        'WHEN TO USE: the user wants a new account — a customer, supplier, bank, expense head, ' +
        'provision and so on.\n\n' +
        'REFUSES: a name that already exists (TallyPrime would otherwise silently overwrite that ' +
        'ledger), and a group that does not exist.\n\n' +
        'Opening balance: give a positive amount and the side (Dr/Cr). It applies from the start of ' +
        'the books; leaving it out means nil.\n\n' +
        WRITE_NOTICE,
      inputSchema: z.object({
        company: companySchema,
        name: masterNameSchema.describe('The new ledger name, exactly as it should appear.'),
        group: masterNameSchema.describe('Existing group to file it under, e.g. "Sundry Debtors".'),
        openingBalance: amountSchema.optional(),
        openingSide: sideSchema.optional().describe('Required with openingBalance.'),
        ...ledgerDetailsShape,
      }),
    },
    async (input) =>
      runTool('tally_create_ledger', deps, async () => {
        if ((input.openingBalance === undefined) !== (input.openingSide === undefined)) {
          throw new TallyError(
            'INVALID_PARAMETERS',
            'Give openingBalance and openingSide together, or neither.'
          );
        }

        const company = await writeTargetCompany(deps, input.company);
        const [ledgers, groups] = [await currentLedgers(deps, company), await currentGroups(deps, company)];

        requireAbsent(ledgers, input.name, (l) => l.name, 'ledger');
        const group = requireExisting(groups, input.group, (g) => g.name, 'group');

        const opening =
          input.openingBalance === undefined || input.openingSide === undefined
            ? undefined
            : toTallySigned(input.openingBalance, input.openingSide);
        const details = planDetails(input, null, await booksBegin(deps, company));
        const fields: LedgerFields = {
          parent: group.name,
          ...(opening === undefined ? {} : { openingBalance: opening }),
          ...details,
        };

        return previewResult(deps, {
          tool: 'tally_create_ledger',
          company,
          summary: `Create ledger "${input.name}" under "${group.name}"` +
            (opening === undefined ? '.' : ` with opening balance ${describeSigned(opening)}.`),
          preview: {
            action: 'CREATE LEDGER',
            ledger: input.name,
            group: group.name,
            groupNature: group.isRevenue ? 'Profit & Loss' : 'Balance Sheet',
            openingBalance: describeSigned(opening),
            ...(Object.keys(details).length > 0 ? { details } : {}),
            ...(opening === undefined
              ? {}
              : {
                  note:
                    'An opening balance on one ledger alone leaves a "Difference in opening ' +
                    'balances" in TallyPrime until the matching opening balance is entered.',
                }),
          },
          body: buildImportRequest('All Masters', company, [ledgerMessage('Create', input.name, fields)]),
          expect: { created: 1 },
          recheck: async (d) => {
            const now = await currentLedgers(d, company);
            if (findExisting(now, input.name, (l) => l.name) !== undefined) {
              throw conflict(`A ledger named "${input.name}" was created in TallyPrime after the preview.`);
            }
            if (findExisting(await currentGroups(d, company), group.name, (g) => g.name) === undefined) {
              throw conflict(`The group "${group.name}" no longer exists in TallyPrime.`);
            }
          },
          verify: async (d) => {
            const made = findExisting(await currentLedgers(d, company), input.name, (l) => l.name);
            if (made === undefined) {
              return { confirmed: false, detail: `no ledger named "${input.name}" was found` };
            }
            const notLanded =
              Object.keys(details).length === 0
                ? []
                : detailMismatches(details, await readLedgerDetails(d, company, made.name));
            const confirmed =
              made.parent === group.name &&
              describeSigned(made.openingBalance?.amount) === describeSigned(opening) &&
              notLanded.length === 0;
            return {
              confirmed,
              detail: {
                ledger: made.name,
                group: made.parent,
                openingBalance: describeSigned(made.openingBalance?.amount),
                ...(notLanded.length > 0 ? { detailsNotStored: notLanded } : {}),
              },
            };
          },
          undo: `Delete it with tally_delete_ledger (name "${input.name}") — possible while it has no vouchers.`,
        });
      })
  );
}

/** The date the books begin, ISO — where a new mailing block is dated from. */
export async function booksBegin(deps: ToolDeps, company: string): Promise<string> {
  const profile = await companyNamed(deps, company);
  const start = profile?.startingFrom ?? null;
  if (start === null) {
    throw new TallyError('TALLY_INVALID_RESPONSE', `Could not read when the books of "${company}" begin.`);
  }
  return start;
}
