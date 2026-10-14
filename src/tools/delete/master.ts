import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildImportRequest, masterMessage } from '../../tally/requests/import.js';
import { companySchema } from '../../schemas/common.js';
import { TallyError } from '../../tally/TallyError.js';
import { runTool, type ToolDeps } from '../shared/toolResult.js';
import { conflict, masterNameSchema, writeTargetCompany } from '../shared/writeInputs.js';
import { findMaster, KIND_SPECS, WRITABLE_KINDS } from '../shared/masterKinds.js';
import { previewResult, WRITE_NOTICE } from '../confirm/flow.js';

/**
 * tally_delete_master — remove an unused group, cost centre, unit, stock group, godown or stock item.
 */
export function registerDeleteMasterTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_delete_master',
    {
      description:
        'Delete a group, cost centre, unit, stock group, godown or stock item from TallyPrime. For ' +
        'ledgers use tally_delete_ledger.\n\n' +
        'TallyPrime refuses to delete a master that is in use — a group with ledgers under it, a ' +
        'unit an item uses, an item with stock movements. That refusal comes back as WRITE_REJECTED ' +
        'and nothing changes.\n\n' +
        WRITE_NOTICE,
      inputSchema: z.object({
        company: companySchema,
        kind: z.enum(WRITABLE_KINDS),
        name: masterNameSchema.describe('The master to delete, by its exact name.'),
      }),
    },
    async (input) =>
      runTool('tally_delete_master', deps, async () => {
        const spec = KIND_SPECS[input.kind];
        const company = await writeTargetCompany(deps, input.company);
        const current = await findMaster(deps, company, input.kind, input.name);
        if (current === undefined) {
          throw new TallyError('INVALID_PARAMETERS', `There is no ${spec.label} named "${input.name}" in TallyPrime.`);
        }

        return previewResult(deps, {
          tool: 'tally_delete_master',
          company,
          summary: `Delete ${spec.label} "${current.name}".`,
          preview: {
            action: `DELETE ${spec.label.toUpperCase()}`,
            ...current,
            note: 'TallyPrime will refuse this if anything still uses it.',
          },
          body: buildImportRequest('All Masters', company, [masterMessage(spec.tag, 'Delete', current.name)]),
          expect: { deleted: 1 },
          recheck: async (d) => {
            if ((await findMaster(d, company, input.kind, current.name)) === undefined) {
              throw conflict(`The ${spec.label} "${current.name}" no longer exists in TallyPrime.`);
            }
          },
          verify: async (d) => {
            const still = await findMaster(d, company, input.kind, current.name);
            return {
              confirmed: still === undefined,
              detail: still === undefined ? `"${current.name}" is gone` : `"${current.name}" is still present`,
            };
          },
          undo: `Recreate it with tally_create_master (kind "${input.kind}", name "${current.name}", parent "${current.parent ?? ''}").`,
        });
      })
  );
}
