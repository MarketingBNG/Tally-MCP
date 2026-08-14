/**
 * Does `List of Accounts` actually carry audit-trail metadata, or only its field names?
 *
 * Background. probe-reports.ts established, against MUDALS TECHNOLOGIES PRIVATE
 * LIMITED on a live TallyPrime:
 *
 *   Edit Log            rejected     no such report
 *   Edit Log Summary    rejected
 *   Audit Trail         rejected
 *   Alteration Report   rejected
 *   List of Accounts    data  7.5 MB  signals: altered, createdby, enteredby, username
 *
 * So there is no report ID for the edit log, but the officially-documented
 * `List of Accounts` export mentions exactly the four things an audit trail is
 * made of. That mention may be nothing: Tally emits the full superset of fields
 * it supports on every record and leaves the inapplicable ones empty, which is
 * documented behaviour and the whole reason `uniformFields` exists. A field name
 * present with no value everywhere would be a false lead, and under the accuracy
 * contract a false lead acted on is worse than a gap admitted.
 *
 * This settles which it is. It counts, per tag name, how many occurrences carry
 * a non-empty value — and prints TAG NAMES AND COUNTS ONLY, never values.
 *
 * That restriction is not politeness. `tests/fixtures/noRealData.test.ts` fails
 * the build if a committed fixture's amounts or GUIDs also appear in the
 * gitignored `samples/`, and this script's output is meant to be quotable in
 * `docs/known-limitations.md`. Printing a username or a timestamp from real
 * books would put company data in a document intended for a public repository.
 *
 * SAFETY: one report ID, now VERIFIED by the run above rather than guessed. One
 * request. Cache off. A health probe before and after. The response is large
 * (7.5 MB) so the timeout is raised well above the default — a timeout here
 * would be a false negative, not a safety event.
 *
 *   TALLY_PROBE_CONFIRM=yes npx tsx scripts/probe-audit-fields.ts
 */

import { loadConfig } from '../src/config/config.js';
import { createLogger } from '../src/utils/logger.js';
import { TallyClient } from '../src/tally/TallyClient.js';
import { buildConnectionProbeRequest, buildReportRequest } from '../src/tally/requests.js';

/**
 * Tags worth reporting on, as lowercase substrings of the tag NAME.
 *
 * Deliberately wider than the audit trail itself: `guid` and `alterid` are the
 * keys any incremental or version-tracking scheme would need, and knowing
 * whether they are populated here decides whether this report can support the
 * cut-off and backdating tests at all.
 */
const OF_INTEREST = [
  'alter',
  'audit',
  'cancel',
  'create',
  'delet',
  'enter',
  'guid',
  'log',
  'modif',
  'user',
  'time',
  'date',
  'version',
  'approve',
  'relatedparty',
];

interface TagStat {
  total: number;
  populated: number;
}

/**
 * Count occurrences and non-empty occurrences per tag name.
 *
 * A single streaming regex over the payload rather than a parse: this must
 * report what Tally sent, not what the server's parser makes of it, for the same
 * reason the other probes count structural markers directly.
 */
function tagStats(body: string): Map<string, TagStat> {
  const stats = new Map<string, TagStat>();

  for (const match of body.matchAll(/<([A-Z][A-Z0-9._]*)\b[^>]*>([^<]*)<\/\1>/gi)) {
    const name = (match[1] ?? '').toUpperCase();
    const value = (match[2] ?? '').trim();

    let stat = stats.get(name);
    if (stat === undefined) {
      stat = { total: 0, populated: 0 };
      stats.set(name, stat);
    }
    stat.total += 1;
    if (value !== '') stat.populated += 1;
  }

  return stats;
}

async function main(): Promise<void> {
  if (process.env.TALLY_PROBE_CONFIRM !== 'yes') {
    console.error(
      'Refusing to run without confirmation. Save your work in TallyPrime, then:\n\n' +
        '  TALLY_PROBE_CONFIRM=yes npx tsx scripts/probe-audit-fields.ts'
    );
    process.exitCode = 1;
    return;
  }

  // 60s: the response is known to be ~7.5 MB. A short timeout would report a
  // false negative on a report that actually works.
  const config = loadConfig({ ...process.env, TALLY_TIMEOUT_MS: '60000', TALLY_CACHE_TTL_MS: '0' });
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

  const response = await client.send(
    buildReportRequest('List of Accounts', { format: config.tallyPreferredFormat }),
    'report'
  );

  const bytes = Buffer.byteLength(response.body, 'utf8');
  const stats = tagStats(response.body);

  console.log(`List of Accounts: ${String(bytes)} bytes, ${String(stats.size)} distinct tag names\n`);

  const interesting = [...stats.entries()]
    .filter(([name]) => OF_INTEREST.some((needle) => name.toLowerCase().includes(needle)))
    .sort((a, b) => b[1].populated - a[1].populated || a[0].localeCompare(b[0]));

  console.log('Tags matching audit-trail / identity interest (NAMES AND COUNTS ONLY):');
  console.log('  populated / total   tag');
  for (const [name, stat] of interesting) {
    const flag = stat.populated === 0 ? '  <- empty scaffolding' : '';
    console.log(
      `  ${String(stat.populated).padStart(7)} / ${String(stat.total).padEnd(7)} ${name}${flag}`
    );
  }

  const populatedCount = interesting.filter(([, stat]) => stat.populated > 0).length;
  console.log(
    [
      '',
      `${String(populatedCount)} of ${String(interesting.length)} matching tags carry any value at all.`,
      '',
      'Reading this:',
      '  - A tag with populated 0 is the documented "full superset, left empty" behaviour.',
      '    It is NOT evidence the data exists, and must not be reported as a capability.',
      '  - A tag carrying values on every record is real data and worth a follow-up on',
      '    what it means — but note this report covers MASTERS, so any timestamp here is',
      '    about when a LEDGER was created or altered, never about a voucher. It cannot',
      '    substitute for the voucher-level edit log that CARO Rule 11(g) requires.',
      '  - Values were deliberately not printed. To inspect one, do it interactively',
      '    against your own books, not through a script whose output gets committed.',
    ].join('\n')
  );

  if (!(await healthy())) {
    console.error('\nTallyPrime stopped answering AFTER the request. Note this in the findings.');
    process.exitCode = 1;
  }
}

await main();
