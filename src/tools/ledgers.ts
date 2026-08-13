import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildLedgerListRequest } from '../tally/requests.js';
import { normalizeLedgers, type Ledger } from '../tally/normalize.js';
import { TallyError } from '../tally/TallyError.js';
import {
  allFieldsSchema,
  companySchema,
  conditionsSchema,
  nameSchema,
  paginationSchema,
  querySchema,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import {
  DEFAULT_PAGE_SIZE,
  FIELD_HEAVY_PAGE_SIZE,
  paginate,
  resolvePagination,
} from '../utils/pagination.js';
import { matchesText } from '../utils/text.js';
import { foldUniformFields, uniformFieldsNote } from '../utils/uniformFields.js';
import {
  applyConditions,
  assertResultSetFits,
  fetchCollection,
  findByName,
  fromPage,
  runTool,
  whole,
  type DatasetSpec,
  type ToolDeps,
} from './toolResult.js';

/**
 * `tally_get_ledgers`: list, search, exact-fetch and multi-condition filter
 * over ledger accounts — one tool, because Tally has no server-side filter or
 * search for masters, so all four are the same full fetch with a different
 * client-side selection on top of it.
 */

const LEDGER_FIELDS: DatasetSpec<Ledger> = {
  name: { type: 'string', get: (l) => l.name },
  parent: { type: 'string', get: (l) => l.parent },
  gstin: { type: 'string', get: (l) => l.gstin },
  openingBalance: { type: 'money', get: (l) => l.openingBalance },
  closingBalance: { type: 'money', get: (l) => l.closingBalance },
};

const BALANCE_NOTE =
  'BALANCES: signed exactly as TallyPrime reports them, where a negative closing balance ' +
  'denotes a debit balance. Signs are never adjusted. A null balance means Tally returned an ' +
  'empty value, which is NOT the same as a balance of zero — a real zero is reported as 0.';

const NARROW_HINT =
  'This company has more ledgers than the configured limit. Raise TALLY_MAX_RECORDS, or add a ' +
  'name/query/conditions filter to narrow instead of listing everything.';

const DESCRIPTION = [
  'Ledger accounts: list, search, fetch one by exact name, or filter by combining conditions ' +
    'on name/parent/GSTIN/balance — one call, one mode, picked by which parameters are given.',
  '',
  'MODES:',
  '- name given: fetch that one ledger exactly. Fails with TALLY_COMPANY_NOT_FOUND naming the ' +
    'ledger, rather than returning null, so a typo is distinguishable from a ledger with genuinely ' +
    'no data.',
  '- query given (no name): case-insensitive substring against the ledger name and its parent ' +
    'group — e.g. "Gupta" finds "Gupta Traders"; "Gupt" does too; "Gupat" does not.',
  '- conditions given: combine more than one field at once — e.g. ledgers under a given group ' +
    'with a closing balance above an amount. Fields: name (string), parent (string), gstin ' +
    '(string), openingBalance (money), closingBalance (money). All conditions AND together. An ' +
    "unknown field or an op invalid for that field's type fails with INVALID_PARAMETERS.",
  '- none given: list every ledger.',
  'name, query and conditions may be combined; each narrows the result further.',
  '',
  'RETURNS: ledger name, parent group, opening and closing balance, and party GSTIN where set.',
  '',
  'DOES NOT RETURN: transactions. This is master data only — use tally_get_vouchers for entries.',
  '',
  BALANCE_NOTE,
  '',
  'COST: TallyPrime cannot filter server-side, so the full ledger list is fetched and filtered ' +
    'here regardless of mode. A narrower filter is not a cheaper request; it is only a smaller ' +
    'response.',
  '',
  'PAGINATION: client-side, for the same reason. A small pageSize does NOT make the call cheap.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

/** One full fetch of the ledger collection, shared across modes. */
export async function fetchLedgers(
  deps: ToolDeps,
  company: string | undefined,
  allFields = false
): Promise<{ ledgers: Ledger[]; warnings: string[] }> {
  const { data, warnings } = await fetchCollection<Ledger>(deps, company, {
    build: (options) => buildLedgerListRequest(options, allFields),
    normalize: (xml, currency) => normalizeLedgers(xml, allFields, currency),
    timeoutClass: allFields ? 'report' : 'standard',
  });

  return { ledgers: data, warnings };
}

export function registerLedgerTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_get_ledgers',
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        name: nameSchema,
        query: querySchema,
        conditions: conditionsSchema,
        company: companySchema,
        includeAllFields: allFieldsSchema,
        ...paginationSchema,
      }),
    },
    async (args) =>
      runTool('tally_get_ledgers', deps, async () => {
        // A named lookup defaults to the full record — asking for one specific
        // ledger is normally an investigation, and the whole record is what
        // makes that answerable.
        const allFields = args.includeAllFields ?? args.name !== undefined;
        const { ledgers, warnings } = await fetchLedgers(deps, args.company, allFields);

        if (args.name !== undefined) {
          const ledger = findByName(ledgers, args.name, (candidate) => candidate.name);
          if (ledger === undefined) {
            throw new TallyError(
              'TALLY_COMPANY_NOT_FOUND',
              `No ledger named "${args.name}" exists in the loaded company.`,
              {
                suggestion:
                  'Check the spelling, or call this tool with a `query` fragment to find the ledger by name.',
              }
            );
          }
          return whole({ ledger, ...(warnings.length > 0 ? { warnings } : {}) }, 1);
        }

        let matches = ledgers;
        if (args.query !== undefined) {
          matches = matches.filter((ledger) =>
            matchesText(args.query as string, ledger.name, ledger.parent)
          );
        }
        if (args.conditions !== undefined && args.conditions.length > 0) {
          matches = applyConditions(matches, LEDGER_FIELDS, args.conditions);
        }

        const pagination = resolvePagination(
          args.page,
          args.pageSize,
          allFields ? FIELD_HEAVY_PAGE_SIZE : DEFAULT_PAGE_SIZE
        );
        assertResultSetFits(matches.length, deps.config, NARROW_HINT);

        const page = paginate(matches, pagination, warnings);
        // Same "populated but constant" pattern as vouchers: this is exactly the
        // case docs/known-limitations.md already found ("115 fields populated,
        // only 36 varied") — folded here so a full-detail ledger listing pays
        // for it only once per response instead of once per ledger.
        const folded = foldUniformFields(
          page.items,
          (ledger) => ledger.fields,
          (ledger, fields) => ({ ...ledger, fields })
        );
        if (Object.keys(folded.uniformFields).length > 0) {
          page.warnings = [
            ...(page.warnings ?? []),
            uniformFieldsNote(
              Object.keys(folded.uniformFields).length,
              folded.foldedOccurrences,
              'ledger'
            ),
          ];
        }

        return fromPage(
          { ...page, items: folded.records },
          {
            ...(args.query === undefined ? {} : { query: args.query }),
            ...(Object.keys(folded.uniformFields).length > 0
              ? { uniformFields: folded.uniformFields }
              : {}),
          }
        );
      })
  );
}
