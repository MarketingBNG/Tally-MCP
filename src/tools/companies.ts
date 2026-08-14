import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { DEFAULT_CURRENCY } from '../utils/numbers.js';
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
import { runTool, whole, type ToolDeps } from './toolResult.js';

/**
 * How many distinct values are retained per field before counting stops.
 *
 * Anything above one already means "this field varies", so collecting every
 * GUID buys nothing. Named because the reporting below must agree with it: a
 * count that reaches this number is a lower bound, not a total.
 */
const DISTINCT_VALUE_CAP = 25;
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
  'Describe the loaded company: its details, the size of its chart of accounts, which data ' +
    'fields it actually uses, and — with includeFeatures — which TallyPrime features it has ' +
    'switched on.',
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
  'FEATURES (with includeFeatures: true): which TallyPrime features this company has switched ' +
    'on, inferred from the data it actually holds — whether it keeps inventory, records GST, ' +
    'uses bill-wise tracking or cost centres. TallyPrime does not expose its feature switches ' +
    '(the F11 settings) over this interface, so each flag is inferred from evidence in the data ' +
    'and comes with that evidence attached. Read a flag as "the data shows this" rather than ' +
    '"the setting is on": a company could have a feature enabled but not yet used it, which ' +
    'reads here as absent. Adds one extra request (the stock item list) beyond the base call.',
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

export interface CompanyListResult {
  companies: Company[];
  warnings?: string[];
}

export function registerCompanyTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_list_companies',
    { description: DESCRIPTION, inputSchema: z.object({}) },
    async () =>
      runTool('tally_list_companies', deps, async () => {
        const response = await deps.client.send(buildCompanyListRequest(), 'standard');
        const { data, warnings } = normalizeCompanies(response.body);

        const allWarnings = [...response.repairs, ...warnings];
        return whole(
          {
            companies: data,
            ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
          } satisfies CompanyListResult,
          data.length
        );
      })
  );

  server.registerTool(
    'tally_get_company',
    {
      description: GET_DESCRIPTION,
      inputSchema: z.object({
        company: companySchema,
        includeFeatures: z
          .boolean()
          .optional()
          .describe(
            'Also infer which TallyPrime features (inventory, GST, bill-wise tracking, cost ' +
              'centres, interest calculation, banking) this company has switched on. Costs one ' +
              'extra request. Defaults to false.'
          ),
      }),
    },
    async (args) =>
      runTool('tally_get_company', deps, async () => {
        const listResponse = await deps.client.send(buildCompanyListRequest(), 'standard');
        const companies = normalizeCompanies(listResponse.body).data;

        // Never `companies[0]` on the unnamed path. This tool's whole output —
        // ledger count, groups in use, which features the data shows — is a
        // description OF a company, so handing back the first one in the list
        // when several are open describes the wrong books under no name at all.
        const company =
          args.company === undefined
            ? companies.length === 1
              ? companies[0]
              : undefined
            : companies.find((entry) => entry.name.toLowerCase() === args.company?.toLowerCase());

        if (company === undefined && args.company === undefined && companies.length > 1) {
          throw new TallyError(
            'TALLY_COMPANY_NOT_LOADED',
            `TallyPrime has ${String(companies.length)} companies loaded, so "which company?" has ` +
              'no single answer.',
            {
              suggestion:
                'Name one with the `company` parameter. Loaded: ' +
                companies.map((entry) => `"${entry.name}"`).join(', ') +
                '.',
            }
          );
        }

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

        // Taken from the record already in hand rather than re-resolved: this is
        // the currency EVERY figure below is denominated in, and it is a symbol
        // as Tally reports it ("$" on a US company), not an ISO code.
        const currency =
          company.currency === null || company.currency.trim() === ''
            ? DEFAULT_CURRENCY
            : company.currency.trim();

        // Full-field ledger fetch: the field names that come back ARE the
        // answer to "what does this company record".
        const ledgerRequest = buildLedgerListRequest(
          { format: deps.config.tallyPreferredFormat },
          true
        );
        const ledgerResponse = await deps.client.send(ledgerRequest, 'report');
        const { data: ledgers, warnings } = normalizeLedgers(ledgerResponse.body, true, currency);

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
            if (seen.size < DISTINCT_VALUE_CAP) seen.add(value);
          }
          if (ledger.parent !== null) {
            groups.set(ledger.parent, (groups.get(ledger.parent) ?? 0) + 1);
          }
        }

        /**
         * `distinctValues` is CAPPED, so it must not be reported as a plain count.
         *
         * The set above stops collecting at 25 (see the comment there), which is
         * a sound optimisation — anything above 1 already means "varies". But a
         * field with 330 distinct values then reported `distinctValues: 25`,
         * which is simply a wrong number, and the accuracy rule for this server
         * does not have an exemption for numbers that are only a bit wrong.
         *
         * So a capped count is reported as `atLeast` instead of `distinctValues`.
         * A reader cannot mistake "at least 25" for "exactly 25", and the two
         * shapes are distinguishable, which a `capped: true` flag alongside an
         * exact-looking figure would not reliably be.
         */
        const varying: Record<
          string,
          { ledgers: number; distinctValues?: number; atLeast?: number }
        > = {};
        const uniform: Record<string, string> = {};

        for (const [key, count] of counts) {
          const distinct = values.get(key)?.size ?? 0;
          if (distinct <= 1 && count === ledgers.length) {
            // Same value on every ledger — a default, not a choice.
            uniform[key] = [...(values.get(key) ?? [])][0] ?? '';
          } else {
            // At the cap, the true count is unknown and only a lower bound can
            // be stated honestly.
            varying[key] =
              distinct >= DISTINCT_VALUE_CAP
                ? { ledgers: count, atLeast: distinct }
                : { ledgers: count, distinctValues: distinct };
          }
        }

        const byLedgerCountDesc = (
          a: [string, { ledgers: number }],
          b: [string, { ledgers: number }]
        ): number => b[1].ledgers - a[1].ledgers || a[0].localeCompare(b[0]);

        const allWarnings = [...listResponse.repairs, ...ledgerResponse.repairs, ...warnings];

        let features: unknown;
        if (args.includeFeatures === true) {
          const companyOption = args.company === undefined ? {} : { company: args.company };
          const stockResponse = await deps.client.send(
            buildStockItemListRequest({
              ...companyOption,
              format: deps.config.tallyPreferredFormat,
            }),
            'standard'
          );
          const stockItems = normalizeStockItems(stockResponse.body, currency).data;
          features = inferCompanyFeatures(ledgers, stockItems);
        }

        // One row: this describes a single company. The ledger count is a
        // property of that description, not a row count of its own.
        return whole(
          {
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
            ...(features === undefined ? {} : { features }),
            ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
          },
          1
        );
      })
  );
}

/**
 * Infer which TallyPrime features (F11 settings) this company has switched
 * on, from evidence in the data it actually holds — TallyPrime does not
 * expose the settings themselves over this interface.
 *
 * GST evidence deliberately comes from three independent places. Checking
 * only party GSTINs reported gst:false on a real company that has 15 GST tax
 * ledgers and GST registration stamped on its vouchers — it simply had not
 * recorded GSTINs against its parties. One narrow signal produced a
 * confidently wrong answer, so all three are reported.
 */
function inferCompanyFeatures(
  ledgers: readonly { gstin: string | null; fields?: Record<string, string> }[],
  stockItems: readonly unknown[]
): unknown {
  const countWhere = (predicate: (fields: Record<string, string>) => boolean): number =>
    ledgers.filter((ledger) => predicate(ledger.fields ?? {})).length;

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
    caveat:
      'Each flag reflects what the DATA shows, not the F11 configuration, which TallyPrime ' +
      'does not expose here. A feature that is enabled but unused reads as not in use.',
  };
}
