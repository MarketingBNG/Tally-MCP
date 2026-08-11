import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  buildCompanyListRequest,
  buildLedgerListRequest,
  buildStockItemListRequest,
} from '../tally/requests.js';
import {
  normalizeCompanies,
  normalizeLedgers,
  normalizeStockItems,
  type Company,
} from '../tally/normalize.js';
import { TallyError } from '../tally/TallyError.js';
import { companySchema, READ_ONLY_NOTICE, UNTRUSTED_CONTENT_NOTICE } from '../schemas/common.js';
import { assertCompanyIsLoaded, runTool, type ToolDeps } from './toolResult.js';

/**
 * Company listing.
 *
 * Worth knowing when reading the output: TallyPrime serves data only for the
 * company it currently has open, so this returns the loaded company rather
 * than every company on disk.
 */

const DESCRIPTION = [
  'List the companies TallyPrime currently has loaded, with the date each set of books begins.',
  '',
  'WHEN TO USE: to confirm which company data will come from before running any analysis, ' +
    'or to check the spelling of a company name for another tool.',
  '',
  'RETURNS: company name and the start date of its books (ISO YYYY-MM-DD).',
  '',
  'DOES NOT RETURN: companies that exist on disk but are not open in TallyPrime. Tally serves ' +
    'only what it currently has loaded, so a company missing here needs opening in Tally itself, ' +
    'not a different query.',
  '',
  'PAGINATION: not applicable — the loaded company list is small.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

const GET_DESCRIPTION = [
  'Describe the loaded company: its details, the size of its chart of accounts, and — ' +
    'importantly — which data fields it actually uses.',
  '',
  'WHEN TO USE: as the FIRST call when asked to audit, review or explore a company you have ' +
    'not looked at yet in this conversation. Different companies in TallyPrime enable different ' +
    'features, so the fields available differ per company. This tool reports what this ' +
    'particular company records, so later queries can be aimed at data that exists rather than ' +
    'guessed at.',
  '',
  'RETURNS: the company name and start date, how many ledgers it has, the account groups in ' +
    'use, and two field lists. "distinguishingFields" are the fields whose values differ ' +
    'between ledgers — this is where the company real data lives and what to aim questions at. ' +
    '"uniformFields" hold the same value on every ledger and are almost always TallyPrime ' +
    'defaults rather than anything this company recorded; treat them as noise unless the value ' +
    'itself is what you need.',
  '',
  'COST: this reads every field of every ledger and is the most expensive call in the server — ' +
    'several megabytes on a mid-sized company. Call it once to orient yourself, then use the ' +
    'narrower tools.',
  '',
  'DOES NOT RETURN: transactions, or any interpretation of what the fields mean.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

const FEATURES_DESCRIPTION = [
  'Report which TallyPrime features this company has switched on, inferred from the data it ' +
    'actually holds.',
  '',
  'WHEN TO USE: to find out whether a line of questioning is even possible before pursuing it — ' +
    'whether the company keeps inventory, records GST, uses bill-wise tracking or cost centres.',
  '',
  'HOW IT IS DETERMINED: TallyPrime does not expose its feature switches (the F11 settings) ' +
    'over this interface, so each flag is inferred from evidence in the data — whether stock ' +
    'items exist, whether GST fields are populated on ledgers, and so on. Each flag therefore ' +
    'comes with the evidence behind it. Read them as "the data shows this" rather than "the ' +
    'setting is on": a company could have a feature enabled but not yet used it, which reads ' +
    'here as absent.',
  '',
  'RETURNS: one entry per feature with a boolean and the evidence supporting it.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

export interface CompanyListResult {
  companies: Company[];
  warnings?: string[];
}

export function registerCompanyTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_list_companies',
    { description: DESCRIPTION, inputSchema: z.object({}) },
    async () =>
      runTool('tally_list_companies', deps.logger, async () => {
        const response = await deps.client.send(buildCompanyListRequest(), 'standard');
        const { data, warnings } = normalizeCompanies(response.body);

        const allWarnings = [...response.repairs, ...warnings];
        return {
          companies: data,
          ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
        } satisfies CompanyListResult;
      })
  );

  server.registerTool(
    'tally_get_company',
    {
      description: GET_DESCRIPTION,
      inputSchema: z.object({ company: companySchema }),
    },
    async (args) =>
      runTool('tally_get_company', deps.logger, async () => {
        const listResponse = await deps.client.send(buildCompanyListRequest(), 'standard');
        const companies = normalizeCompanies(listResponse.body).data;

        const company =
          args.company === undefined
            ? companies[0]
            : companies.find((entry) => entry.name.toLowerCase() === args.company?.toLowerCase());

        if (company === undefined) {
          const loaded = companies.map((entry) => entry.name);
          throw new TallyError(
            'TALLY_COMPANY_NOT_LOADED',
            args.company === undefined
              ? 'TallyPrime does not have any company loaded.'
              : `TallyPrime does not have "${args.company}" open — currently loaded: ${loaded.join(', ') || 'none'}.`,
            {
              suggestion:
                'Open that company in TallyPrime and try again. Tally serves data only for the company it currently has loaded.',
            }
          );
        }

        // Full-field ledger fetch: the field names that come back ARE the
        // answer to "what does this company record".
        const ledgerRequest = buildLedgerListRequest(
          { format: deps.config.tallyPreferredFormat },
          true
        );
        const ledgerResponse = await deps.client.send(ledgerRequest, 'report');
        const { data: ledgers, warnings } = normalizeLedgers(ledgerResponse.body, true);

        // Count, per field, how many ledgers carry it AND how many distinct
        // values it takes.
        //
        // The distinct count is what makes this useful. Tally stamps a large
        // set of feature fields onto every ledger with a default value, so a
        // raw presence count reports ABATEMENTPERCENTAGE on 330 of 330
        // ledgers and makes boilerplate look like the company's most-used
        // field. A field holding the same single value everywhere carries no
        // information about this company; one that varies does.
        const values = new Map<string, Set<string>>();
        const counts = new Map<string, number>();
        const groups = new Map<string, number>();

        for (const ledger of ledgers) {
          for (const [key, value] of Object.entries(ledger.fields ?? {})) {
            counts.set(key, (counts.get(key) ?? 0) + 1);
            let seen = values.get(key);
            if (seen === undefined) {
              seen = new Set<string>();
              values.set(key, seen);
            }
            // Cap the set: a GUID-like field would otherwise retain one entry
            // per ledger for no benefit, since anything above 1 is "varies".
            if (seen.size < 25) seen.add(value);
          }
          if (ledger.parent !== null) {
            groups.set(ledger.parent, (groups.get(ledger.parent) ?? 0) + 1);
          }
        }

        const varying: Record<string, { ledgers: number; distinctValues: number }> = {};
        const uniform: Record<string, string> = {};

        for (const [key, count] of counts) {
          const distinct = values.get(key)?.size ?? 0;
          if (distinct <= 1 && count === ledgers.length) {
            // Same value on every ledger — a default, not a choice.
            uniform[key] = [...(values.get(key) ?? [])][0] ?? '';
          } else {
            varying[key] = { ledgers: count, distinctValues: distinct };
          }
        }

        const byLedgerCountDesc = (
          a: [string, { ledgers: number }],
          b: [string, { ledgers: number }]
        ): number => b[1].ledgers - a[1].ledgers || a[0].localeCompare(b[0]);

        const allWarnings = [...listResponse.repairs, ...ledgerResponse.repairs, ...warnings];

        return {
          company,
          ledgerCount: ledgers.length,
          groups: Object.fromEntries([...groups.entries()].sort((a, b) => b[1] - a[1])),
          /**
           * Fields that differ between ledgers — where this company's actual
           * data lives, and the place to aim an investigation.
           */
          distinguishingFields: Object.fromEntries(
            [...Object.entries(varying)].sort(byLedgerCountDesc)
          ),
          /**
           * Fields Tally set identically on every ledger. Almost always
           * product defaults rather than anything this company recorded.
           */
          uniformFields: uniform,
          ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
        };
      })
  );

  server.registerTool(
    'tally_get_company_features',
    {
      description: FEATURES_DESCRIPTION,
      inputSchema: z.object({ company: companySchema }),
    },
    async (args) =>
      runTool('tally_get_company_features', deps.logger, async () => {
        await assertCompanyIsLoaded(deps, args.company);
        const companyOption = args.company === undefined ? {} : { company: args.company };

        const ledgerResponse = await deps.client.send(
          buildLedgerListRequest(
            { ...companyOption, format: deps.config.tallyPreferredFormat },
            true
          ),
          'report'
        );
        const { data: ledgers, warnings } = normalizeLedgers(ledgerResponse.body, true);

        const stockResponse = await deps.client.send(
          buildStockItemListRequest({
            ...companyOption,
            format: deps.config.tallyPreferredFormat,
          }),
          'standard'
        );
        const stockItems = normalizeStockItems(stockResponse.body).data;

        const countWhere = (predicate: (fields: Record<string, string>) => boolean): number =>
          ledgers.filter((ledger) => predicate(ledger.fields ?? {})).length;

        // GST evidence deliberately comes from three independent places.
        //
        // Checking only party GSTINs reported gst:false on a real company that
        // has 15 GST tax ledgers and GST registration stamped on its vouchers —
        // it simply had not recorded GSTINs against its parties. One narrow
        // signal produced a confidently wrong answer, so all three are reported.
        const partiesWithGstin = ledgers.filter((ledger) => ledger.gstin !== null).length;
        const partiesWithRegistrationType = countWhere(
          (fields) => fields.GSTREGISTRATIONTYPE !== undefined
        );
        const gstTaxLedgers = countWhere((fields) => fields.GSTDUTYHEAD !== undefined);
        const gstLedgers = partiesWithGstin + partiesWithRegistrationType + gstTaxLedgers;
        const billWise = countWhere((fields) => fields.ISBILLWISEON === 'Yes');
        const costCentres = countWhere((fields) => fields.ISCOSTCENTRESON === 'Yes');
        const interest = countWhere((fields) => fields.ISINTERESTON === 'Yes');
        const bankLedgers = countWhere((fields) => fields.IFSCODE !== undefined);

        // Evidence alongside every flag: a bare boolean invites being read as
        // the F11 setting, which is not what this can observe.
        return {
          company: args.company ?? '(currently loaded)',
          features: {
            inventory: {
              inUse: stockItems.length > 0,
              evidence: `${String(stockItems.length)} stock item(s) exist`,
            },
            gst: {
              inUse: gstLedgers > 0,
              evidence:
                `${String(partiesWithGstin)} ledger(s) carry a GSTIN, ` +
                `${String(partiesWithRegistrationType)} carry a GST registration type, ` +
                `${String(gstTaxLedgers)} are GST tax ledgers (with a duty head)`,
            },
            billWiseTracking: {
              inUse: billWise > 0,
              evidence: `${String(billWise)} ledger(s) have bill-wise tracking enabled`,
            },
            costCentres: {
              inUse: costCentres > 0,
              evidence: `${String(costCentres)} ledger(s) have cost centres enabled`,
            },
            interestCalculation: {
              inUse: interest > 0,
              evidence: `${String(interest)} ledger(s) have interest calculation enabled`,
            },
            banking: {
              inUse: bankLedgers > 0,
              evidence: `${String(bankLedgers)} ledger(s) record bank details such as an IFSC code`,
            },
          },
          caveat:
            'Each flag reflects what the DATA shows, not the F11 configuration, which TallyPrime ' +
            'does not expose here. A feature that is enabled but unused reads as not in use.',
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      })
  );
}
