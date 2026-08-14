/**
 * Reach cost-centre and bill allocations WITHOUT the request shape that hung Tally.
 *
 * ## What happened, and what it cost
 *
 * probe-voucher-reach.ts sent a collection whose TYPE was the dotted name
 * `Voucher.AllLedgerEntries`, on the strength of `tally-database-loader` using
 * dotted sub-collections in production. TallyPrime stopped responding and had to
 * be RESTARTED, losing whatever was unsaved. Recorded here because it is the
 * most important safety fact this project has learned since the allowlist rule:
 *
 *   NEVER send a dotted name as a <COLLECTION>'s <TYPE>. It is not merely
 *   unsupported — it wedges the application.
 *
 * The reasoning error is worth naming too, because it is repeatable: the loader
 * uses that dotted name as a collection reference INSIDE a generated TDL report
 * with PART/LINE/FIELD walking. It never exports a dotted collection directly.
 * "The loader uses X" was treated as licence for a request form the loader does
 * not send.
 *
 * ## What this probes instead
 *
 * The smallest possible departure from a shape already proven safe. The shipped
 * builder sends `<TYPE>Voucher</TYPE>` with `AllLedgerEntries` in the FETCH list
 * and works in production, returning 285 vouchers and 991 entries on this
 * company. So this keeps TYPE=Voucher exactly as-is and only extends the FETCH
 * list with NESTED PATHS:
 *
 *   AllLedgerEntries.CostCentreAllocations   -> tool #3, cost centres
 *   AllLedgerEntries.BillAllocations         -> Schedule III ageing
 *   AllLedgerEntries.BankAllocations         -> 3CD clause 24 payment mode
 *
 * If a nested path is unsupported, the expected failure is that Tally ignores it
 * or returns a LINEERROR — the same class of harmless rejection an unknown report
 * ID produces — because the collection itself remains a plain Voucher collection.
 *
 * ## Guards
 *
 * - ONE candidate per invocation, chosen by argv. No loop: the previous run's
 *   damage came from a loop continuing to the next stage.
 * - A 6s timeout. The known-good equivalent request completes in about 2s on
 *   this company, so 6s is generous for success and fast for failure.
 * - Health probe BEFORE and AFTER, and the after-check result is printed as part
 *   of the finding rather than assumed.
 * - Counts and tag names only. No amounts, names, cost-centre names or
 *   narrations are printed, since this output is quotable in docs/.
 *
 *   TALLY_PROBE_CONFIRM=yes npx tsx scripts/probe-nested-fetch.ts costcentre
 *   TALLY_PROBE_CONFIRM=yes npx tsx scripts/probe-nested-fetch.ts bill
 *   TALLY_PROBE_CONFIRM=yes npx tsx scripts/probe-nested-fetch.ts bank
 *   TALLY_PROBE_CONFIRM=yes npx tsx scripts/probe-nested-fetch.ts control
 */

import { loadConfig } from '../src/config/config.js';
import { createLogger } from '../src/utils/logger.js';
import { TallyClient } from '../src/tally/TallyClient.js';
import { buildConnectionProbeRequest, escapeXml } from '../src/tally/requests.js';

/** The nested paths to try, one per run. `control` proves the run works. */
const CANDIDATES: Record<string, { nested: string[]; why: string }> = {
  control: {
    nested: [],
    why: 'Positive control: the shipped fetch list, nothing nested. Must return vouchers.',
  },
  costcentre: {
    nested: ['AllLedgerEntries.CostCentreAllocations'],
    why: 'Gates tool #3. This company has 37 ledgers with cost centres enabled.',
  },
  /**
   * The `costcentre` run above was informative in an unexpected way: it produced
   * no COSTCENTREALLOCATIONS but turned CATEGORYALLOCATIONS from 0 to 985. That
   * is Tally telling us the hierarchy — a ledger entry carries COST CATEGORY
   * allocations, and the cost centres hang underneath those. So the path has one
   * more level than the plan assumed.
   */
  costcentre2: {
    nested: ['AllLedgerEntries.CategoryAllocations.CostCentreAllocations'],
    why: 'The corrected hierarchy: entry -> CategoryAllocations -> CostCentreAllocations.',
  },
  /** Both levels named explicitly, in case the intermediate must be requested too. */
  costcentre3: {
    nested: [
      'AllLedgerEntries.CategoryAllocations',
      'AllLedgerEntries.CategoryAllocations.CostCentreAllocations',
    ],
    why: 'As costcentre2, but naming the intermediate level as well.',
  },
  bill: {
    nested: ['AllLedgerEntries.BillAllocations'],
    why: 'Gates Schedule III ageing. NOTE: this company has bill-wise tracking OFF, so an empty result is expected and is NOT evidence the path is unsupported.',
  },
  bank: {
    nested: ['AllLedgerEntries.BankAllocations'],
    why: 'Gates 3CD clause 24. The existing bank tool already reads BANKALLOCATIONS, so this should succeed.',
  },
};

/**
 * A plain Voucher collection — TYPE is never dotted — with nested fetch paths.
 *
 * The base fetch list mirrors the shipped builder so that the only variable
 * between this and a known-safe request is the nested path itself.
 */
function nestedFetchRequest(nested: readonly string[]): string {
  const fields = [
    'Date',
    'VoucherTypeName',
    'VoucherNumber',
    'AllLedgerEntries',
    ...nested,
  ];

  return [
    '<ENVELOPE>',
    '<HEADER>',
    '<VERSION>1</VERSION>',
    '<TALLYREQUEST>Export</TALLYREQUEST>',
    '<TYPE>Collection</TYPE>',
    '<ID>ProbeNestedVouchers</ID>',
    '</HEADER>',
    '<BODY><DESC>',
    '<STATICVARIABLES>',
    '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>',
    '</STATICVARIABLES>',
    '<TDL><TDLMESSAGE>',
    // TYPE stays the plain, proven `Voucher`. This is the whole safety argument.
    '<COLLECTION NAME="ProbeNestedVouchers" ISMODIFY="No" ISFIXED="No">',
    '<TYPE>Voucher</TYPE>',
    `<FETCH>${escapeXml(fields.join(','))}</FETCH>`,
    '</COLLECTION>',
    '</TDLMESSAGE></TDL>',
    '</DESC></BODY>',
    '</ENVELOPE>',
  ].join('');
}

/** Count occurrences of a tag name, case-insensitive, without parsing. */
function countTag(body: string, tag: string): number {
  return [...body.matchAll(new RegExp(`<${tag}\\b`, 'gi'))].length;
}

async function main(): Promise<void> {
  const which = process.argv[2] ?? '';
  const candidate = CANDIDATES[which];

  if (process.env.TALLY_PROBE_CONFIRM !== 'yes' || candidate === undefined) {
    console.error(
      [
        'Usage: TALLY_PROBE_CONFIRM=yes npx tsx scripts/probe-nested-fetch.ts <name>',
        '',
        `Names: ${Object.keys(CANDIDATES).join(', ')}`,
        '',
        'Run ONE at a time and check TallyPrime between runs. A previous probe in this',
        'project wedged Tally badly enough to need a restart, which is why this script',
        'refuses to loop over candidates.',
      ].join('\n')
    );
    process.exitCode = 1;
    return;
  }

  // 6s: the known-good equivalent takes ~2s here. Long enough to succeed,
  // short enough that a wedge is caught before it compounds.
  const config = loadConfig({ ...process.env, TALLY_TIMEOUT_MS: '6000', TALLY_CACHE_TTL_MS: '0' });
  const client = new TallyClient(config, createLogger('error'));

  const healthy = async (): Promise<boolean> => {
    try {
      await client.send(buildConnectionProbeRequest(), 'standard', { bypassCache: true });
      return true;
    } catch {
      return false;
    }
  };

  console.log(`Candidate: ${which}`);
  console.log(`Why:       ${candidate.why}`);
  console.log(`Nested:    ${candidate.nested.join(', ') || '(none — control)'}\n`);

  if (!(await healthy())) {
    console.error('TallyPrime is not answering BEFORE the probe. Nothing was sent.');
    process.exitCode = 1;
    return;
  }
  console.log('pre-flight health: OK');

  let sent = false;
  try {
    const response = await client.send(nestedFetchRequest(candidate.nested), 'standard');
    sent = true;

    const body = response.body;
    const lineError = /<LINEERROR>([^<]*)<\/LINEERROR>/i.exec(body)?.[1];

    console.log(`bytes:             ${String(Buffer.byteLength(body, 'utf8'))}`);
    console.log(`LINEERROR:         ${lineError ?? '(none)'}`);
    console.log(`VOUCHER:           ${String(countTag(body, 'VOUCHER'))}`);
    console.log(`ALLLEDGERENTRIES:  ${String(countTag(body, 'ALLLEDGERENTRIES\\.LIST'))}`);
    console.log(`COSTCENTREALLOC:   ${String(countTag(body, 'COSTCENTREALLOCATIONS\\.LIST'))}`);
    console.log(`BILLALLOCATIONS:   ${String(countTag(body, 'BILLALLOCATIONS\\.LIST'))}`);
    console.log(`BANKALLOCATIONS:   ${String(countTag(body, 'BANKALLOCATIONS\\.LIST'))}`);
    console.log(`CATEGORYALLOC:     ${String(countTag(body, 'CATEGORYALLOCATIONS\\.LIST'))}`);
  } catch (error) {
    console.log(`REQUEST FAILED:    ${(error as Error).message}`);
  }

  const after = await healthy();
  console.log(`\npost-flight health: ${after ? 'OK' : '*** NOT ANSWERING ***'}`);

  if (!after) {
    console.error(
      [
        '',
        'TallyPrime is not answering after this request. Check it on screen.',
        `Record this candidate (${which}) as UNSAFE and do not send it again.`,
      ].join('\n')
    );
    process.exitCode = 1;
    return;
  }

  if (sent) {
    console.log(
      [
        '',
        'Reading this: a non-zero count for the allocation list this candidate asked for',
        'means the nested path WORKS and that data is reachable without the dotted TYPE.',
        'Zero with no LINEERROR is ambiguous — either unsupported, or genuinely absent on',
        'this company — and the "why" line above says which is expected here.',
      ].join('\n')
    );
  }
}

await main();
