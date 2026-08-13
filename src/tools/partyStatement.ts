import { z } from 'zod';
import { Decimal } from 'decimal.js';
import type { McpServer } from '@modelcontextprotocol/server';
import { type Ledger, type Voucher } from '../tally/normalize.js';
import { DEFAULT_CURRENCY, type Money } from '../utils/numbers.js';
import {
  companySchema,
  dateRangeSchema,
  PERIOD_NOTE,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import {
  assertResultSetFits,
  noteEmptyDefaultedPeriod,
  periodWasDefaulted,
  resolvePeriod,
  runTool,
  whole,
  type ToolDeps,
} from './toolResult.js';
import { fetchLedgers } from './ledgers.js';
import { fetchVouchers } from './vouchers.js';
import { buildMovements, type LedgerMovement } from './ledgerMovements.js';
import { voucherMatchesAnyField } from './voucherFilters.js';
import { matchesText } from '../utils/text.js';

/**
 * "Everything about this party" in one round trip.
 *
 * ## Why this exists
 *
 * A question like "what did Mr Sai draw as salary, professional fees, and
 * anything else, this year" cannot be answered by one ledger lookup: a
 * director's payments routinely sit on several differently-named ledgers
 * (salary, professional fees, loan/drawings), and the only way to find them
 * without knowing the exact names is to search first, then fetch each one in
 * turn. Doing that with the single-ledger tools costs one full ledger-master
 * fetch and one full voucher-register fetch PER ledger investigated — several
 * round trips to a TallyPrime HTTP server that only serves one request at a
 * time, each over the same full-year period.
 *
 * This tool fetches the ledger master once and the voucher register for the
 * period once, then reuses both for every matching ledger and for a
 * narration/field-level scan across the same register — so the answer comes
 * back as one call regardless of how many ledgers the name turns out to
 * touch, or capped and clearly marked as truncated for a party with an
 * unusually large number of matches.
 */

const DEFAULT_LEDGER_LIMIT = 10;
const MAX_LEDGER_LIMIT = 25;
const DEFAULT_MENTION_LIMIT = 20;
const MAX_MENTION_LIMIT = 100;

const DESCRIPTION = [
  'Everything one party (a person, director, staff member or company) was paid or booked ' +
    'against, across every matching ledger, in a single call.',
  '',
  'WHEN TO USE: "how much did X draw as salary vs professional fees", "check all payments to ' +
    'X this year", or any question spanning more than one ledger for the same party. For a ' +
    "single, already-known ledger name, tally_get_ledger_transactions is more direct — this tool's " +
    'value is finding and combining several.',
  '',
  'HOW MATCHING WORKS: the query is matched, case-insensitive, as a substring against every ' +
    'ledger name and parent group (same rule as tally_get_ledgers with a `query`). Every ledger that matches ' +
    'gets its own statement in the response. "Sai" therefore finds "Sai - Salary" and ' +
    '"Sai - Professional Fees" as two separate ledgers, not one merged figure — the response is ' +
    'per-ledger on purpose, since salary and professional fees are different tax and compliance ' +
    'categories and must not be silently summed.',
  '',
  'OTHER MENTIONS: separately, the voucher register for the period is scanned for the same text ' +
    'anywhere in a narration, party name, reference or nested field — catching a payment booked ' +
    "through a ledger that does not carry the party's name (e.g. a reimbursement voucher naming " +
    'them only in the narration). These are listed separately, not merged into the ledger figures, ' +
    'since a text mention is weaker evidence than a dedicated ledger.',
  '',
  'RETURNS: per matched ledger — opening balance, every movement with a running balance, total ' +
    'debit, total credit, and the computed closing balance for the period; plus the capped list of ' +
    'other mentions.',
  '',
  PERIOD_NOTE,
  '',
  'LIMITS: at most ' +
    String(MAX_LEDGER_LIMIT) +
    ' matching ledgers are fetched in full (default ' +
    String(DEFAULT_LEDGER_LIMIT) +
    ') and at most ' +
    String(MAX_MENTION_LIMIT) +
    ' other mentions are listed (default ' +
    String(DEFAULT_MENTION_LIMIT) +
    '). "truncated" says when a cap was hit — narrow the query or the date range rather than ' +
    'trusting a capped list as complete.',
  '',
  'BALANCES: signed exactly as TallyPrime reports them — a negative closing balance denotes a ' +
    'debit balance. The running balance and computed closing balance are computed by this server ' +
    'from the opening balance plus the period movements, not figures TallyPrime itself reported; ' +
    "each ledger's own reported closing balance is included separately for comparison.",
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

interface LedgerStatement {
  name: string;
  parent: string | null;
  openingBalance: Money | null;
  computedClosingBalance: Money | null;
  tallyReportedClosingBalance: Money | null;
  totalDebit: Money;
  totalCredit: Money;
  movementCount: number;
  movements: LedgerMovement[];
}

export function registerPartyStatementTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_get_party_statement',
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            'Case-insensitive substring matched against ledger names and parent groups, e.g. a ' +
              "person's or company's name."
          ),
        company: companySchema,
        ...dateRangeSchema,
        ledgerLimit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LEDGER_LIMIT)
          .optional()
          .describe(
            `Maximum number of matching ledgers to fetch in full. Defaults to ${String(DEFAULT_LEDGER_LIMIT)}.`
          ),
        mentionLimit: z
          .number()
          .int()
          .min(1)
          .max(MAX_MENTION_LIMIT)
          .optional()
          .describe(
            `Maximum number of "other mentions" to list. Defaults to ${String(DEFAULT_MENTION_LIMIT)}.`
          ),
      }),
    },
    async (args) =>
      runTool('tally_get_party_statement', deps, async () => {
        const period = resolvePeriod(args.fromDate, args.toDate);

        const ledgerLimit = args.ledgerLimit ?? DEFAULT_LEDGER_LIMIT;
        const mentionLimit = args.mentionLimit ?? DEFAULT_MENTION_LIMIT;
        const warnings: string[] = [];

        const { ledgers: allLedgers, warnings: ledgerWarnings } = await fetchLedgers(
          deps,
          args.company
        );
        warnings.push(...ledgerWarnings);

        const allMatches = allLedgers.filter((ledger) =>
          matchesText(args.query, ledger.name, ledger.parent)
        );

        // No matching ledger is a finding, not a failure — but there is
        // nothing to build a statement from, and no reason to pay for the
        // (expensive) voucher register fetch just to scan for mentions of a
        // name that identifies no account at all.
        if (allMatches.length === 0) {
          // Nothing matched, and nothing was withheld: a complete answer that
          // happens to be empty. `truncated: false` is the honest report.
          return whole(
            {
              query: args.query,
              period,
              ledgersMatched: { total: 0, truncated: false, names: [] },
              ledgers: [],
              otherMentions: { total: 0, truncated: false, matches: [] },
              ...(warnings.length > 0 ? { warnings } : {}),
            },
            0
          );
        }

        const matchedLedgers = allMatches.slice(0, ledgerLimit);

        // Full fields: the same fetch also drives the other-mentions scan,
        // which needs nested field values, not just the common ones.
        const { vouchers, warnings: voucherWarnings } = await fetchVouchers(
          deps,
          args.company,
          period,
          true
        );
        warnings.push(...voucherWarnings);
        warnings.push(
          ...(await noteEmptyDefaultedPeriod(
            deps,
            period,
            periodWasDefaulted(args.fromDate, args.toDate),
            vouchers.length
          ))
        );

        const ledgers = matchedLedgers.map((ledger) =>
          buildLedgerStatement(vouchers, ledger, warnings)
        );

        const totalMovements = ledgers.reduce((sum, ledger) => sum + ledger.movementCount, 0);
        assertResultSetFits(
          totalMovements,
          deps.config,
          'Narrow the date range, or lower ledgerLimit to fewer matching ledgers.'
        );

        // Lower-cased to match how buildMovements decides the SAME question.
        // With an exact-string Set, a voucher whose entry name differs from the
        // ledger master only in case counted in the statement AND was listed as
        // an "other mention" — and the description promises mentions are not
        // merged into the ledger figures, so a reader adding them double-counts.
        const matchedLedgerNames = new Set(
          matchedLedgers.map((ledger) => ledger.name.trim().toLowerCase())
        );
        const otherMentionMatches = vouchers.filter((voucher) => {
          const touchesMatchedLedger = voucher.entries.some((entry) =>
            matchedLedgerNames.has(entry.ledgerName.trim().toLowerCase())
          );
          if (touchesMatchedLedger) return false;

          return (
            matchesText(args.query, voucher.partyLedgerName, voucher.narration) ||
            voucherMatchesAnyField(voucher, args.query)
          );
        });

        const ledgersTruncated = allMatches.length > ledgerLimit;
        const mentionsTruncated = otherMentionMatches.length > mentionLimit;
        const mentions = otherMentionMatches.slice(0, mentionLimit);

        return {
          data: {
            query: args.query,
            period,
            ledgersMatched: {
              total: allMatches.length,
              truncated: ledgersTruncated,
              names: matchedLedgers.map((ledger) => ledger.name),
            },
            ledgers,
            otherMentions: {
              total: otherMentionMatches.length,
              truncated: mentionsTruncated,
              matches: mentions.map((voucher) => ({
                date: voucher.date,
                voucherNumber: voucher.voucherNumber,
                voucherType: voucher.voucherType,
                partyLedgerName: voucher.partyLedgerName,
                narration: voucher.narration,
                ledgers: voucher.entries.map((entry) => entry.ledgerName),
              })),
            },
            ...(warnings.length > 0 ? { warnings } : {}),
          },
          // Both caps count as rows: a statement line and a mention are each
          // a row of accounting data the caller received.
          rows: totalMovements + mentions.length,
          // Either cap biting makes the whole answer partial.
          truncated: ledgersTruncated || mentionsTruncated,
        };
      })
  );
}

function buildLedgerStatement(
  vouchers: readonly Voucher[],
  ledger: Ledger,
  warnings: string[]
): LedgerStatement {
  const movements = buildMovements(vouchers, ledger.name, ledger.openingBalance, warnings);
  const currency = ledger.openingBalance?.currency ?? DEFAULT_CURRENCY;

  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);
  // Counted, not silently skipped. An unreadable entry means the totals below
  // are UNDERSTATED by a real amount, and a total that omits a line while
  // movementCount still counts it does not reconcile against its own rows.
  let excluded = 0;

  for (const movement of movements) {
    if (movement.amount === null) {
      excluded += 1;
      continue;
    }
    const magnitude = new Decimal(movement.amount.amount).abs();
    if (movement.side === 'debit') totalDebit = totalDebit.plus(magnitude);
    else totalCredit = totalCredit.plus(magnitude);
  }

  if (excluded > 0) {
    warnings.push(
      `${String(excluded)} movement(s) on "${ledger.name}" carry an amount TallyPrime did not report readably, so totalDebit and totalCredit exclude them and are understated. movementCount still counts them.`
    );
  }

  const last = movements[movements.length - 1];

  return {
    name: ledger.name,
    parent: ledger.parent,
    openingBalance: ledger.openingBalance,
    // See the same field in ledgerTransactions.ts: `??` would report the
    // opening balance as the closing one whenever the running total could not
    // be computed. Only "no movements at all" may fall back.
    computedClosingBalance: last === undefined ? ledger.openingBalance : last.runningBalance,
    tallyReportedClosingBalance: ledger.closingBalance,
    totalDebit: { amount: totalDebit.toFixed(), currency },
    totalCredit: { amount: totalCredit.toFixed(), currency },
    /** How many movements are missing from the two totals above. */
    ...(excluded > 0 ? { movementsExcludedFromTotals: excluded } : {}),
    movementCount: movements.length,
    movements,
  };
}
