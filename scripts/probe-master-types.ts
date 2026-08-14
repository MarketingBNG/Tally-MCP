/**
 * Which master COLLECTION TYPES exist, and does this company populate them?
 *
 * Three questions this settles, all currently blocking plan items:
 *
 *  1. COST CENTRES. probe-nested-fetch.ts established that the nested fetch path
 *     `AllLedgerEntries.CategoryAllocations.CostCentreAllocations` is accepted and
 *     safe, but returns zero COSTCENTREALLOCATIONS on this company — while
 *     `tally_get_company` reports 37 ledgers with cost centres ENABLED. Those two
 *     facts are consistent only if the feature is switched on but never used on
 *     transactions. If no CostCentre masters exist, that is confirmed, and the
 *     zero is the company's answer rather than a limit of the request.
 *
 *  2. BUDGETS. Every budget REPORT id was rejected (`Budget Variance`, `Budgets`).
 *     A collection TYPE is the other possibility, and it gates tool #2. No
 *     documentation anywhere describes either path, so this is the only way to know.
 *
 *  3. Whether the plain-TYPE collection route generalises. Ledgers, Groups,
 *     StockItems and VoucherTypes all work in production; if CostCentre and
 *     Budget answer the same way, the route is general and the consolidated
 *     master tool in the plan can cover them with no new mechanism.
 *
 * SAFETY: every request goes through `buildCollectionRequest` — the SAME builder
 * production uses — with a plain, undotted TYPE and a full inline definition.
 * This is deliberately the exact shape already proven safe hundreds of times,
 * differing only in the type name. A wrong type name is expected to return a
 * LINEERROR or an empty envelope, which is the harmless class.
 *
 * A dotted TYPE is NEVER sent. One of those wedged TallyPrime badly enough to
 * need a restart earlier in this session; see probe-nested-fetch.ts.
 *
 * Health-probed between every candidate, aborting on the first non-answer.
 * Counts only — no master names or amounts are printed.
 *
 *   TALLY_PROBE_CONFIRM=yes npx tsx scripts/probe-master-types.ts
 */

import { loadConfig } from '../src/config/config.js';
import { createLogger } from '../src/utils/logger.js';
import { TallyClient } from '../src/tally/TallyClient.js';
import { buildCollectionRequest, buildConnectionProbeRequest } from '../src/tally/requests.js';

/**
 * Collection name, Tally type, and the fields to ask for.
 *
 * `Name` alone is enough to prove existence and count. Extra fields are
 * requested only where the plan needs to know they exist.
 */
const CANDIDATES: {
  id: string;
  type: string;
  fields: string[];
  why: string;
}[] = [
  {
    id: 'ProbeLedgers',
    type: 'Ledger',
    fields: ['Name'],
    why: 'Positive control: known to work in production. If this fails, the run is wrong.',
  },
  {
    id: 'ProbeNoSuchType',
    type: 'NoSuchTypeXyz',
    fields: ['Name'],
    why: 'Negative control: proves a bad type name rejects harmlessly rather than hanging.',
  },
  {
    id: 'ProbeCostCentres',
    type: 'CostCentre',
    fields: ['Name', 'Parent', 'Category'],
    why: 'Q1: do cost centre masters exist at all on this company?',
  },
  {
    id: 'ProbeCostCategories',
    type: 'CostCategory',
    fields: ['Name'],
    why: 'Q1: the parent level of the hierarchy the nested fetch revealed.',
  },
  {
    id: 'ProbeBudgets',
    type: 'Budget',
    fields: ['Name'],
    why: 'Q2: gates tool #2. Every budget report ID was rejected.',
  },
  {
    id: 'ProbeCurrencies',
    type: 'Currency',
    fields: ['Name', 'IsBaseCurrency'],
    why: 'Already used in production; included as a second positive control.',
  },
  {
    id: 'ProbeGodowns',
    type: 'Godown',
    fields: ['Name'],
    why: 'Location-wise stock depends on this; company has no inventory, so expect empty.',
  },
];

function classify(body: string): string {
  const lineError = /<LINEERROR>([^<]*)<\/LINEERROR>/i.exec(body)?.[1];
  if (lineError !== undefined) return `REJECTED (${lineError.trim().slice(0, 50)})`;
  if (/server is running/i.test(body)) return 'LIVENESS';
  if (/^\s*<ENVELOPE>\s*<\/ENVELOPE>\s*$/i.test(body)) return 'EMPTY';
  return 'data';
}

/** How many records came back, counted structurally. */
function recordCount(body: string, type: string): number {
  return Math.max(
    [...body.matchAll(new RegExp(`<${type}\\b`, 'gi'))].length,
    [...body.matchAll(/<NAME>/gi)].length
  );
}

async function main(): Promise<void> {
  if (process.env.TALLY_PROBE_CONFIRM !== 'yes') {
    console.error(
      'Refusing to run without confirmation. Save your work in TallyPrime, then:\n\n' +
        '  TALLY_PROBE_CONFIRM=yes npx tsx scripts/probe-master-types.ts'
    );
    process.exitCode = 1;
    return;
  }

  const config = loadConfig({ ...process.env, TALLY_TIMEOUT_MS: '8000', TALLY_CACHE_TTL_MS: '0' });
  const client = new TallyClient(config, createLogger('error'));

  const healthy = async (): Promise<boolean> => {
    try {
      await client.send(buildConnectionProbeRequest(), 'standard', { bypassCache: true });
      return true;
    } catch {
      return false;
    }
  };

  if (!(await healthy())) {
    console.error('TallyPrime did not answer the initial health probe. Nothing was sent.');
    process.exitCode = 1;
    return;
  }

  console.log('  type                 verdict                              bytes  records');
  for (const candidate of CANDIDATES) {
    try {
      const response = await client.send(
        buildCollectionRequest(candidate.id, candidate.type, candidate.fields, {
          format: config.tallyPreferredFormat,
        }),
        'standard'
      );
      const bytes = Buffer.byteLength(response.body, 'utf8');
      console.log(
        `  ${candidate.type.padEnd(20)} ${classify(response.body).padEnd(36)} ` +
          `${String(bytes).padStart(7)}  ${String(recordCount(response.body, candidate.type)).padStart(6)}`
      );
    } catch (error) {
      console.log(`  ${candidate.type.padEnd(20)} ERROR  ${(error as Error).message}`);
    }

    if (!(await healthy())) {
      console.error(`\n*** TallyPrime STOPPED ANSWERING after type "${candidate.type}". ABORTING. ***`);
      process.exitCode = 1;
      return;
    }
  }

  console.log(
    [
      '',
      'Done. TallyPrime answered throughout.',
      '',
      'Reading this:',
      '  - The two positive controls must show "data". The negative control must NOT.',
      '  - CostCentre with 0 records settles Q1: the zero allocations seen earlier are',
      '    this company not using the feature, not a limitation of the nested fetch path.',
      '  - Budget returning data would unblock tool #2; rejected or empty means the plan',
      '    must record it as having no verified XML path and say so rather than guess.',
    ].join('\n')
  );
}

await main();
