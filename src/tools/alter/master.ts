import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildImportRequest, masterMessage } from '../../tally/requests/import.js';
import { companySchema } from '../../schemas/common.js';
import { TallyError } from '../../tally/TallyError.js';
import { runTool, type ToolDeps } from '../shared/toolResult.js';
import { conflict, masterNameSchema, writeTargetCompany } from '../shared/writeInputs.js';
import {
  assertFieldsFitKind,
  findMaster,
  KIND_SPECS,
  masterInputShape,
  resolveMasterFields,
  sameParent,
} from '../shared/masterKinds.js';
import { previewResult, WRITE_NOTICE } from '../confirm/flow.js';

/**
 * tally_alter_master — change a group, cost centre, unit, stock group, godown or stock item.
 */
export function registerAlterMasterTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_alter_master',
    {
      description:
        'Change an EXISTING group, cost centre, unit, stock group, godown or stock item in ' +
        'TallyPrime: rename it, move it under another parent, or update the fields its kind takes ' +
        '(see tally_create_master). Only the fields you give change. Units cannot be renamed. For ' +
        'ledgers use tally_alter_ledger.\n\n' +
        'Moving a group moves every ledger under it to the new place in the balance sheet or P&L.\n\n' +
        WRITE_NOTICE,
      inputSchema: z.object({
        company: companySchema,
        name: masterNameSchema.describe('The master to change, by its current name.'),
        newName: masterNameSchema.optional().describe('Rename it to this.'),
        ...masterInputShape,
      }),
    },
    async (input) =>
      runTool('tally_alter_master', deps, async () => {
        const { kind } = input;
        const spec = KIND_SPECS[kind];
        assertFieldsFitKind(kind, input);

        const company = await writeTargetCompany(deps, input.company);
        const current = await findMaster(deps, company, kind, input.name);
        if (current === undefined) {
          throw new TallyError('INVALID_PARAMETERS', `There is no ${spec.label} named "${input.name}" in TallyPrime.`);
        }

        const { fields, shown } = await resolveMasterFields(deps, company, kind, input, current.baseUnits);
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const [key, value] of Object.entries(shown)) {
          changes[key] = { from: key === 'parent' ? current.parent : '(see TallyPrime)', to: value };
        }
        if (input.newName !== undefined && input.newName !== current.name) {
          if (!spec.canRename) throw new TallyError('INVALID_PARAMETERS', `A ${spec.label} cannot be renamed here.`);
          if (input.newName.toLowerCase() !== current.name.toLowerCase()) {
            const clash = await findMaster(deps, company, kind, input.newName);
            if (clash !== undefined) {
              throw new TallyError('INVALID_PARAMETERS', `A ${spec.label} named "${clash.name}" already exists.`);
            }
          }
          fields.rename = input.newName;
          changes.name = { from: current.name, to: input.newName };
        }
        if (fields.parent !== undefined && sameParent(fields.parent, current.parent)) {
          delete fields.parent;
          delete changes.parent;
        }
        if (Object.keys(changes).length === 0) {
          throw new TallyError('INVALID_PARAMETERS', `Nothing to change on ${spec.label} "${current.name}".`);
        }
        const finalName = fields.rename ?? current.name;

        return previewResult(deps, {
          tool: 'tally_alter_master',
          company,
          summary: `Alter ${spec.label} "${current.name}": ${Object.keys(changes).join(', ')}.`,
          preview: { action: `ALTER ${spec.label.toUpperCase()}`, name: current.name, changes },
          body: buildImportRequest('All Masters', company, [masterMessage(spec.tag, 'Alter', current.name, fields)]),
          expect: { altered: 1 },
          recheck: async (d) => {
            const now = await findMaster(d, company, kind, current.name);
            if (now === undefined || !sameParent(now.parent, current.parent)) {
              throw conflict(`The ${spec.label} "${current.name}" was changed in TallyPrime after the preview.`);
            }
          },
          verify: async (d) => {
            const after = await findMaster(d, company, kind, finalName);
            if (after === undefined) return { confirmed: false, detail: `no ${spec.label} named "${finalName}" was found` };
            const parentOk = fields.parent === undefined || sameParent(after.parent, fields.parent);
            return { confirmed: parentOk, detail: after };
          },
          undo:
            `Alter it back with tally_alter_master (kind "${kind}", name "${finalName}") to name ` +
            `"${current.name}" and parent "${current.parent ?? ''}".`,
        });
      })
  );
}
