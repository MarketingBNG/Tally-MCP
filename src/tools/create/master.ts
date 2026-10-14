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
 * tally_create_master — groups, cost centres, units, stock groups, godowns, stock items.
 */
export function registerCreateMasterTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_create_master',
    {
      description:
        'Create a NEW master in TallyPrime: an account group, cost centre, unit of measure, stock ' +
        'group, godown (location) or stock item. For ledgers use tally_create_ledger.\n\n' +
        'Fields by kind: group needs parent (an existing group — its nature follows the parent). ' +
        'costCentre takes parent and category. unit takes formalName and decimalPlaces (name is ' +
        'the symbol, e.g. "kg"). stockGroup and godown take parent. stockItem takes parent (stock ' +
        'group), baseUnits (required) and an optional opening quantity and rate.\n\n' +
        'REFUSES a name that already exists (TallyPrime would otherwise overwrite it) and any ' +
        'parent, category or unit that does not exist.\n\n' +
        WRITE_NOTICE,
      inputSchema: z.object({ company: companySchema, name: masterNameSchema, ...masterInputShape }),
    },
    async (input) =>
      runTool('tally_create_master', deps, async () => {
        const { kind } = input;
        const spec = KIND_SPECS[kind];
        assertFieldsFitKind(kind, input);
        if (spec.parentRequired && (input.parent === undefined || input.parent === '')) {
          throw new TallyError('INVALID_PARAMETERS', `A new ${spec.label} needs a parent.`);
        }
        if (kind === 'stockItem' && input.baseUnits === undefined) {
          throw new TallyError('INVALID_PARAMETERS', 'A new stock item needs baseUnits (its unit of measure).');
        }

        const company = await writeTargetCompany(deps, input.company);
        const existing = await findMaster(deps, company, kind, input.name);
        if (existing !== undefined) {
          throw new TallyError('INVALID_PARAMETERS', `A ${spec.label} named "${existing.name}" already exists in TallyPrime.`, {
            suggestion: 'To change it, use tally_alter_master. To make a new one, choose a different name.',
          });
        }
        const { fields, shown } = await resolveMasterFields(deps, company, kind, input);

        return previewResult(deps, {
          tool: 'tally_create_master',
          company,
          summary: `Create ${spec.label} "${input.name}"` + (fields.parent ? ` under "${fields.parent}".` : '.'),
          preview: { action: `CREATE ${spec.label.toUpperCase()}`, name: input.name, ...shown },
          body: buildImportRequest('All Masters', company, [masterMessage(spec.tag, 'Create', input.name, fields)]),
          expect: { created: 1 },
          recheck: async (d) => {
            if ((await findMaster(d, company, kind, input.name)) !== undefined) {
              throw conflict(`A ${spec.label} named "${input.name}" was created in TallyPrime after the preview.`);
            }
          },
          verify: async (d) => {
            const made = await findMaster(d, company, kind, input.name);
            if (made === undefined) return { confirmed: false, detail: `no ${spec.label} named "${input.name}" was found` };
            const parentOk = fields.parent === undefined || sameParent(made.parent, fields.parent);
            const valueOk = fields.openingValue === undefined || made.openingValue === fields.openingValue;
            return { confirmed: parentOk && valueOk, detail: made };
          },
          undo: `Delete it with tally_delete_master (kind "${kind}", name "${input.name}") while nothing uses it.`,
        });
      })
  );
}
