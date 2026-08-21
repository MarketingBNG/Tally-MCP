import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Money } from '../utils/numbers.js';
import {
  companySchema,
  dateRangeSchema,
  isoDateSchema,
  paginationSchema,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import {
  ageBills,
  allocationAmount,
  DEFAULT_AGEING_BUCKETS,
  SCHEDULE_III_INCOMPLETE_NOTE,
  SCHEDULE_III_LABELS,
  scheduleIiiBoundaries,
  validateBuckets,
  type DatedBillAllocation,
  type PartyAgeing,
} from './ageing.js';
import { paginate, resolvePagination } from '../utils/pagination.js';
import {
  assertResultSetFits,
  fromPage,
  noteEmptyDefaultedPeriod,
  periodWasDefaulted,
  resolvePeriodForCompany,
  runTool,
  type ToolDeps,
} from './toolResult.js';
import { fetchLedgers } from './ledgers.js';
import { fetchVouchers } from './vouchers.js';
import type { Voucher } from '../tally/normalize.js';

/**
 * Receivables and payables.
 *
 * ## What these return, and what they deliberately do not
 *
 * Two things are combined:
 *
 * 1. **Party balances** from the ledger masters, filtered to the debtor or
 *    creditor groups. These are Tally's own closing balances.
 * 2. **Bill references** from `BILLALLOCATIONS.LIST` on vouchers in the
 *    period, where the company uses bill-wise accounting.
 *
 * **No OVERDUE analysis is computed, ever.** Overdue needs a due date per bill,
 * and the due date depends on credit terms that may be recorded per party, per
 * bill, or not at all. Where Tally reports a bill's due date it is passed
 * through verbatim; where it does not, the field is simply absent. Deriving a
 * due date from an invoice date plus an assumed credit period would produce a
 * bucket that looks authoritative and is invented — the single most dangerous
 * thing this tool could do. That remains true and unchanged.
 *
 * **Ageing by bill age is available, opt-in.** `includeAgeing` buckets each
 * bill reference by how long ago it AROSE — days from the raising voucher's own
 * date to a date the caller names. Both dates are Tally's; nothing is assumed.
 * It is off by default so the plain answer stays exactly what it was, and the
 * schedule is labelled with its basis in the payload, because a "60-90 days"
 * bucket reads as overdue to anyone who did not compute it. See ageing.ts for
 * the netting rule and the period-coverage limitation, which is the part most
 * likely to mislead.
 */

/**
 * Default groups. Tally's built-in group names for parties.
 *
 * These are only defaults: a company can file parties under custom groups, so
 * the group list is overridable per call and the groups actually used are
 * echoed back. Hardcoding them silently would under-report on any company with
 * a custom chart of accounts.
 */
const DEFAULT_RECEIVABLE_GROUPS = ['Sundry Debtors'];
const DEFAULT_PAYABLE_GROUPS = ['Sundry Creditors'];

const AGEING_NOTE = [
  'AGEING (opt-in, and NOT overdue analysis). includeAgeing gives a bucketed schedule per party. ' +
    'Buckets count DAYS SINCE EACH BILL AROSE — from the raising voucher date to `ageingAsOn` ' +
    '(defaults to period end). Both dates come from Tally; nothing is assumed.',
  '',
  'This is bill AGE, not days overdue, and that difference must reach the user. A 75-day-old bill ' +
    'is 15 days overdue on 60-day terms and not overdue at all on 90-day terms. This server does ' +
    'not know the terms, so present a bucket as age since the bill was raised, and never call it ' +
    'overdue unless the user supplies terms and you state that basis.',
  '',
  'Bill references are NETTED first: Tally records an invoice as "New Ref" and each payment as ' +
    '"Agst Ref", so unnetted allocations would count a settled invoice twice. Outstanding-ness is ' +
    'taken from the sign of the RAISING allocation, since a receivable bill arrives negative and a ' +
    'payable positive and sign alone would be meaningless.',
  '',
  'Besides `buckets` (count and netted amount per range), four figures are deliberately NOT ' +
    'bucketed and each is a real finding — read them before quoting the buckets as the whole ' +
    'picture:',
  '- `settlementsAgainstEarlierBills` — references appearing only as payments, the invoice ' +
    'predating the range and absent from this data. Non-zero is direct evidence the schedule is ' +
    'incomplete.',
  '- `settledInPeriod` — raised and cleared inside the period, so nothing outstanding.',
  '- `overSettled` — more applied than the bill was raised for.',
  '- `undated` / `unreferenced` — no readable date, and Tally "On Account" allocations belonging ' +
    'to no bill. Never forced into a bucket.',
  '',
  'COVERAGE — the limitation that matters most. Bills come from vouchers IN THE REQUESTED PERIOD, ' +
    'so a bill raised earlier cannot be aged — and an ageing question is usually about exactly ' +
    'those old invoices. Widen the range to cover when the bills were raised, and never present ' +
    'this as the ageing of the whole ledger without saying which period it covers.',
].join('\n');

const SHARED_NOTES = [
  'NO DUE DATE IS DERIVED AND NO OVERDUE FIGURE IS COMPUTED. Where Tally records a due date it is ' +
    'passed through; where it does not, there is none to report. This server will not derive one ' +
    'from an invoice date plus an assumed credit period, because that presents an invented figure ' +
    'as fact. If asked what is overdue, work it out from the dates present and SAY what basis you ' +
    'used — and if the dates are absent, say that instead.',
  '',
  AGEING_NOTE,
  '',
  'GROUPS: parties are identified by their Tally parent group. Defaults are the built-in names; a ' +
    'company may use custom ones — pass "groups" to override, and check "groupsUsed" if a party ' +
    'you expected is missing.',
  '',
  'BALANCES: Tally own closing balances, signs unchanged — negative denotes a DEBIT balance. A ' +
    'null balance means Tally returned an empty value, NOT zero.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

interface OutstandingSpec {
  side: 'receivable' | 'payable';
  label: string;
  defaultGroups: readonly string[];
  when: string;
}

const SPECS: Record<'receivable' | 'payable', OutstandingSpec> = {
  receivable: {
    side: 'receivable',
    label: 'receivables — money owed TO the company by its customers',
    defaultGroups: DEFAULT_RECEIVABLE_GROUPS,
    when: 'to see who owes the company money, and the bills behind those balances.',
  },
  payable: {
    side: 'payable',
    label: 'payables — money the company OWES to its suppliers',
    defaultGroups: DEFAULT_PAYABLE_GROUPS,
    when: 'to see who the company owes money to, and the bills behind those balances.',
  },
};

const sideSchema = z
  .enum(['receivable', 'payable'])
  .describe(
    'receivable: money owed TO the company by its customers. payable: money the company OWES ' +
      'to its suppliers.'
  );

export interface PartyOutstanding {
  party: string;
  group: string | null;
  closingBalance: Money | null;
  /**
   * Bill references found on vouchers in the period for this party, exactly as
   * Tally recorded them. Empty when the company does not use bill-wise
   * accounting, which is not an error.
   */
  bills: Record<string, string>[];
  /**
   * Bucketed bill age, present only when `includeAgeing` was requested and this
   * party has bills. Omitted rather than zero-filled, so an absent schedule
   * never reads as "examined and found clear".
   */
  ageing?: PartyAgeing;
}

const DESCRIPTION = [
  'Receivables or payables, picked by `side` — one call, one side.',
  '',
  `receivable: ${SPECS.receivable.when}`,
  `payable: ${SPECS.payable.when}`,
  '',
  'RETURNS: one row per party with its closing balance and, where the company uses ' +
    'bill-wise accounting, the bill references recorded on vouchers in the period — plus a ' +
    'bucketed `ageing` schedule per party when includeAgeing is set.',
  '',
  SHARED_NOTES,
].join('\n');

/**
 * What one receivables or payables run produced.
 *
 * The ageing basis travels WITH the rows rather than beside them. A bucket
 * quoted without "as at this date, by bill age, covering only bills raised in
 * this period" is the single most misreadable figure this server produces, so
 * it is part of the result and not something a caller may forget to ask for.
 */
export interface ExecutedOutstanding {
  side: 'receivable' | 'payable';
  period: { fromDate: string; toDate: string };
  groupsUsed: string[];
  /** Present only when ageing was requested; null rather than zero-filled. */
  ageingBasis: {
    asOn: string;
    measure: string;
    buckets: number[];
    coverage: string;
  } | null;
  rows: PartyOutstanding[];
  warnings: string[];
}

/**
 * Receivables or payables for one company and period.
 *
 * Extracted from the tool handler on the same rule `executeVoucherTest` and
 * `executeStatement` follow: a second reader — here, the scheduled workbook
 * export — calls this rather than writing its own party-and-bill assembly,
 * because two ways of deciding who counts as a debtor is two answers.
 */
export async function executeOutstanding(
  deps: ToolDeps,
  args: {
    side: 'receivable' | 'payable';
    groups?: string[] | undefined;
    includeZeroBalances?: boolean | undefined;
    includeAgeing?: boolean | undefined;
    ageingAsOn?: string | undefined;
    ageingBuckets?: number[] | undefined;
    ageingPreset?: 'days' | 'schedule_iii' | undefined;
    creditTerms?: { party?: string | undefined; group?: string | undefined; days: number }[] | undefined;
    company?: string | undefined;
    fromDate?: string | undefined;
    toDate?: string | undefined;
  }
): Promise<ExecutedOutstanding> {
  const spec = SPECS[args.side];
  const period = await resolvePeriodForCompany(deps, args.fromDate, args.toDate, args.company);

  // Validated FIRST, before anything is fetched. Measured live: rejecting a
  // descending bucket list used to take 1,180ms, because the ledger and
  // voucher fetches happened before the check. Input validation must never
  // cost a round trip to Tally, let alone a 21MB one.
  const wantsAgeing = args.includeAgeing === true;
  const scheduleIii = args.ageingPreset === 'schedule_iii';
  // Resolved before the fetch, like the bucket validation below and for
  // the same measured reason: rejecting bad input must not cost a 21MB
  // round trip to Tally.
  const ageingAsOnEarly = args.ageingAsOn;

  const groups = args.groups ?? [...spec.defaultGroups];
  const groupSet = new Set(groups.map((group) => group.toLowerCase()));

  const { ledgers, warnings: ledgerWarnings } = await fetchLedgers(deps, args.company);

  const parties = ledgers.filter((ledger) =>
    groupSet.has((ledger.parent ?? '').toLowerCase())
  );

  // Bill references live in nested structures on vouchers, so full
  // detail is needed to read them.
  const { vouchers, warnings: voucherWarnings } = await fetchVouchers(
    deps,
    args.company,
    period,
    // Nested only. This tool reads bill allocations and no scalar voucher field, so
    // asking for every field would cost 18.3MB to use none of it.
    false,
    true
  );

  const billsByParty = collectBills(vouchers);

  const ageingAsOn = ageingAsOnEarly ?? period.toDate;
  const buckets = wantsAgeing
    ? scheduleIii
      ? validateBuckets(scheduleIiiBoundaries(ageingAsOn))
      : validateBuckets(args.ageingBuckets ?? DEFAULT_AGEING_BUCKETS)
    : [];
  const ageingWarnings: string[] = [];
  if (wantsAgeing && scheduleIii) {
    ageingWarnings.push(SCHEDULE_III_INCOMPLETE_NOTE);
    ageingWarnings.push(
      'MAPPING TO THE DISCLOSURE: the FIRST bucket returned is "future-dated" and is not ' +
        'part of Schedule III — it holds bills dated after the as-at date, which the ' +
        'disclosure has no line for and which are worth looking at on their own account. ' +
        'The five buckets AFTER it are, in order: ' +
        SCHEDULE_III_LABELS.join('; ') +
        `. Boundaries were computed as calendar months back from ${ageingAsOn}.`
    );
    if (args.ageingBuckets !== undefined) {
      ageingWarnings.push(
        'ageingBuckets was ignored because ageingPreset is "schedule_iii", which defines ' +
          'its own boundaries. Drop one of the two so the request says one thing.'
      );
    }
  }

  // Party terms beat group terms: the more specific statement wins, which
  // is how someone writing "30 days generally, 60 for this customer"
  // expects it to be read.
  const creditByParty = new Map<string, number>();
  const creditByGroup = new Map<string, number>();
  for (const term of args.creditTerms ?? []) {
    if (term.party !== undefined) creditByParty.set(term.party.toLowerCase(), term.days);
    else if (term.group !== undefined) creditByGroup.set(term.group.toLowerCase(), term.days);
  }
  const creditDaysFor = (name: string, group: string | null): number | null =>
    creditByParty.get(name.toLowerCase()) ??
    creditByGroup.get((group ?? '').toLowerCase()) ??
    null;

  const rows: PartyOutstanding[] = parties
    .filter((ledger) => {
      if (args.includeZeroBalances === true) return true;
      // Null is kept deliberately: it means "not reported", and
      // dropping it would hide a party rather than show a zero.
      if (ledger.closingBalance === null) return true;
      return Number(ledger.closingBalance.amount) !== 0;
    })
    .map((ledger) => {
      const allocations = billsByParty.get(ledger.name.toLowerCase()) ?? [];
      const ageing = wantsAgeing
        ? ageBills(
            allocations,
            ageingAsOn,
            buckets,
            ageingWarnings,
            creditDaysFor(ledger.name, ledger.parent)
          )
        : null;

      return {
        party: ledger.name,
        group: ledger.parent,
        closingBalance: ledger.closingBalance,
        bills: allocations.map((allocation) => allocation.fields),
        ...(ageing === null ? {} : { ageing }),
      };
    });

  assertResultSetFits(
    rows.length,
    deps.config,
    'Narrow the group list, or raise TALLY_MAX_RECORDS.'
  );

  const warnings = [
    // Bills come from the period's vouchers, so an empty defaulted
    // period silently strips every bill reference off these balances.
    ...(await noteEmptyDefaultedPeriod(deps, period, periodWasDefaulted(args.fromDate, args.toDate), vouchers.length, args.company)),
    ...ledgerWarnings,
    ...voucherWarnings,
    ...ageingWarnings,
  ];

  if (wantsAgeing) {
    // Attached to every ageing response, not only the suspicious ones.
    // The basis is what stops a bucket being read as overdue, and it has
    // to be present on the call that gets quoted back to the user.
    warnings.push(
      `Ageing is by BILL AGE as at ${ageingAsOn} — days since the raising voucher's own ` +
        'date — and is NOT days overdue: no due date or credit period was used. It covers ' +
        `only bills raised between ${period.fromDate} and ${period.toDate}, so any invoice ` +
        'older than that period is absent from the schedule. State both points when ' +
        'reporting the buckets.'
    );
  }

  if (parties.length === 0) {
    warnings.push(
      `No ledgers were found under ${groups.map((g) => `"${g}"`).join(', ')}. This company may file its parties under different group names — check tally_get_masters type "ledger" for the groups actually in use.`
    );
  }


  return {
    side: args.side,
    period,
    groupsUsed: groups,
    ageingBasis: wantsAgeing
      ? {
          asOn: ageingAsOn,
          measure: 'days since the bill was raised, not days overdue',
          buckets,
          coverage: `bills raised between ${period.fromDate} and ${period.toDate} only`,
        }
      : null,
    rows,
    warnings,
  };
}

export function registerOutstandingTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_get_outstanding',
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        side: sideSchema,
        groups: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Parent groups identifying these parties. Defaults to "Sundry Debtors" for ' +
              'receivable or "Sundry Creditors" for payable. Override if this company files ' +
              'parties elsewhere.'
          ),
        includeZeroBalances: z
          .boolean()
          .optional()
          .describe(
            'Include parties whose closing balance is zero. Defaults to false, since a settled ' +
              'account is rarely what is being asked about. Parties with a NULL balance are ' +
              'always included, because null means Tally reported nothing rather than nil.'
          ),
        includeAgeing: z
          .boolean()
          .optional()
          .describe(
            'Add a bucketed ageing schedule per party, by DAYS SINCE EACH BILL AROSE — not days ' +
              'overdue. Defaults to false. Read the AGEING section of this description before ' +
              'reporting any bucket, especially the coverage limitation: only bills raised inside ' +
              'the requested period can be aged.'
          ),
        ageingAsOn: isoDateSchema
          .optional()
          .describe(
            'Date to age bills as at, ISO YYYY-MM-DD. Defaults to the end of the period. Only ' +
              'used when includeAgeing is true.'
          ),
        ageingBuckets: z
          .array(z.number().int().min(1))
          .max(10)
          .optional()
          .describe(
            'Day boundaries for the buckets, ascending, e.g. [30, 60, 90] (the default) gives ' +
              '0-30, 31-60, 61-90 and 90+. Must ascend strictly so buckets cannot overlap. ' +
              'Ignored when ageingPreset is "schedule_iii", which sets its own.'
          ),
        ageingPreset: z
          .enum(['days', 'schedule_iii'])
          .optional()
          .describe(
            'Which bucket set to use. "days" (default) uses ageingBuckets. "schedule_iii" uses ' +
              'the Schedule III disclosure periods — under 6 months, 6 months to 1 year, 1-2 ' +
              'years, 2-3 years, over 3 years — computed as real calendar months back from ' +
              'ageingAsOn, not as fixed day counts. Read the warning it returns: Schedule III ' +
              'also needs an undisputed/disputed and good/doubtful split that TallyPrime does ' +
              'not hold, so this is the ageing half of the note and not the whole note.'
          ),
        creditTerms: z
          .array(
            z.object({
              party: z
                .string()
                .min(1)
                .optional()
                .describe('Party ledger name, matched case-insensitively and exactly.'),
              group: z
                .string()
                .min(1)
                .optional()
                .describe('Parent group name, applying to every party filed under it.'),
              days: z.number().int().min(0).describe('Credit days allowed.'),
            })
          )
          .max(500)
          .optional()
          .describe(
            'Credit terms you supply, which turn bill AGE into genuinely OVERDUE. A `party` ' +
              'entry wins over a `group` entry for the same party. Parties with no matching ' +
              'entry get NO overdue figure at all rather than a zero — a zero would read as ' +
              '"nothing overdue", which cannot be said without knowing when the bills were due. ' +
              'TallyPrime may record a credit period, but it may record it per party, per bill ' +
              'or not at all, so this is asked for rather than assumed.'
          ),
        company: companySchema,
        ...dateRangeSchema,
        ...paginationSchema,
      }),
    },
    async (args) =>
      runTool('tally_get_outstanding', deps, async () => {
        const pagination = resolvePagination(args.page, args.pageSize);
        const executed = await executeOutstanding(deps, args);

        return fromPage(paginate(executed.rows, pagination, executed.warnings), {
          side: executed.side,
          period: executed.period,
          groupsUsed: executed.groupsUsed,
          ...(executed.ageingBasis === null ? {} : { ageingBasis: executed.ageingBasis }),
        });
      })
  );
}

/**
 * Index bill allocations by party ledger name.
 *
 * Bill references hang off the ledger entry, so the party is taken from the
 * entry's own ledger name rather than the voucher's party field — on a journal
 * adjusting several parties they differ, and using the voucher-level party
 * would attribute one party's bills to another.
 *
 * The voucher's date travels with each allocation because that is the only date
 * a bill has: TallyPrime records no per-allocation date in this export, so the
 * raising voucher's date IS when the bill arose. Ageing needs it, and reading it
 * here keeps the raw `fields` map free of anything this server added to it.
 */
function collectBills(vouchers: readonly Voucher[]): Map<string, DatedBillAllocation[]> {
  const byParty = new Map<string, DatedBillAllocation[]>();

  for (const voucher of vouchers) {
    for (const entry of voucher.entries) {
      const bills = entry.nested?.['BILLALLOCATIONS.LIST'] ?? [];
      if (bills.length === 0) continue;

      const key = entry.ledgerName.toLowerCase();
      const existing = byParty.get(key) ?? [];
      existing.push(
        ...bills.map((bill) => ({
          reference: bill.fields.NAME ?? '',
          voucherDate: voucher.date,
          billType: bill.fields.BILLTYPE ?? null,
          amount: allocationAmount(bill.fields, entry.amount?.currency),
          fields: bill.fields,
        }))
      );
      byParty.set(key, existing);
    }
  }

  return byParty;
}
