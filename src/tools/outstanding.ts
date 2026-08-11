import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildLedgerListRequest, buildVoucherRegisterRequest } from '../tally/requests.js';
import { normalizeLedgers, normalizeVouchers } from '../tally/normalize.js';
import type { Money } from '../utils/numbers.js';
import {
  companySchema,
  dateRangeSchema,
  paginationSchema,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import { paginate, resolvePagination } from '../utils/pagination.js';
import {
  assertCompanyIsLoaded,
  assertResultSetFits,
  resolvePeriod,
  runTool,
  type ToolDeps,
} from './toolResult.js';

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
 * **No ageing is computed.** Ageing needs a due date per bill, and the due
 * date depends on credit terms that may be recorded per party, per bill, or
 * not at all. Where Tally reports a bill's due date it is passed through
 * verbatim; where it does not, the field is simply absent. Deriving a due date
 * from an invoice date plus an assumed credit period would produce an ageing
 * bucket that looks authoritative and is invented — the single most dangerous
 * thing this tool could do.
 *
 * Overdue analysis is therefore Claude's to do, from the dates present, with
 * the basis stated.
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

const SHARED_NOTES = [
  'NO AGEING IS COMPUTED. Where TallyPrime records a due date on a bill it is passed through as ' +
    'Tally recorded it; where it does not, there is no due date to report. This server will not ' +
    'derive one from an invoice date plus an assumed credit period, because that would present ' +
    'an invented figure as fact. If the user asks what is overdue, work it out from the dates ' +
    'present and SAY what basis you used — and if the dates are not there, say that instead.',
  '',
  'GROUPS: parties are identified by their TallyPrime parent group. The defaults are the ' +
    'built-in names, but a company may use custom groups — pass "groups" to override, and check ' +
    '"groupsUsed" in the response if a party you expected is missing.',
  '',
  'BALANCES: Tally own closing balances, signs unchanged. Negative denotes a debit balance in ' +
    'Tally encoding. A null balance means Tally returned an empty value, NOT zero.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

interface OutstandingSpec {
  tool: string;
  label: string;
  defaultGroups: readonly string[];
  when: string;
}

const SPECS: readonly OutstandingSpec[] = [
  {
    tool: 'tally_get_receivables',
    label: 'receivables — money owed TO the company by its customers',
    defaultGroups: DEFAULT_RECEIVABLE_GROUPS,
    when: 'to see who owes the company money, and the bills behind those balances.',
  },
  {
    tool: 'tally_get_payables',
    label: 'payables — money the company OWES to its suppliers',
    defaultGroups: DEFAULT_PAYABLE_GROUPS,
    when: 'to see who the company owes money to, and the bills behind those balances.',
  },
];

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
}

export function registerOutstandingTools(server: McpServer, deps: ToolDeps): void {
  for (const spec of SPECS) {
    server.registerTool(
      spec.tool,
      {
        description: [
          `List ${spec.label}.`,
          '',
          `WHEN TO USE: ${spec.when}`,
          '',
          'RETURNS: one row per party with its closing balance and, where the company uses ' +
            'bill-wise accounting, the bill references recorded on vouchers in the period.',
          '',
          SHARED_NOTES,
        ].join('\n'),
        inputSchema: z.object({
          groups: z
            .array(z.string().min(1))
            .optional()
            .describe(
              `Parent groups identifying these parties. Defaults to ${spec.defaultGroups
                .map((group) => `"${group}"`)
                .join(', ')}. Override if this company files parties elsewhere.`
            ),
          includeZeroBalances: z
            .boolean()
            .optional()
            .describe(
              'Include parties whose closing balance is zero. Defaults to false, since a settled ' +
                'account is rarely what is being asked about. Parties with a NULL balance are ' +
                'always included, because null means Tally reported nothing rather than nil.'
            ),
          company: companySchema,
          ...dateRangeSchema,
          ...paginationSchema,
        }),
      },
      async (args) =>
        runTool(spec.tool, deps.logger, async () => {
          const pagination = resolvePagination(args.page, args.pageSize);
          const period = resolvePeriod(args.fromDate, args.toDate);
          await assertCompanyIsLoaded(deps, args.company);

          const companyOption = args.company === undefined ? {} : { company: args.company };
          const groups = args.groups ?? [...spec.defaultGroups];
          const groupSet = new Set(groups.map((group) => group.toLowerCase()));

          const ledgerResponse = await deps.client.send(
            buildLedgerListRequest({ ...companyOption, format: deps.config.tallyPreferredFormat }),
            'standard'
          );
          const { data: ledgers, warnings: ledgerWarnings } = normalizeLedgers(
            ledgerResponse.body
          );

          const parties = ledgers.filter((ledger) =>
            groupSet.has((ledger.parent ?? '').toLowerCase())
          );

          // Bill references live in nested structures on vouchers, so full
          // detail is needed to read them.
          const voucherResponse = await deps.client.send(
            buildVoucherRegisterRequest({
              ...companyOption,
              fromDate: period.fromDate,
              toDate: period.toDate,
              format: deps.config.tallyPreferredFormat,
            }),
            'report'
          );
          const { data: vouchers, warnings: voucherWarnings } = normalizeVouchers(
            voucherResponse.body,
            true
          );

          const billsByParty = collectBills(vouchers);

          const rows: PartyOutstanding[] = parties
            .filter((ledger) => {
              if (args.includeZeroBalances === true) return true;
              // Null is kept deliberately: it means "not reported", and
              // dropping it would hide a party rather than show a zero.
              if (ledger.closingBalance === null) return true;
              return Number(ledger.closingBalance.amount) !== 0;
            })
            .map((ledger) => ({
              party: ledger.name,
              group: ledger.parent,
              closingBalance: ledger.closingBalance,
              bills: billsByParty.get(ledger.name.toLowerCase()) ?? [],
            }));

          assertResultSetFits(
            rows.length,
            deps.config,
            'Narrow the group list, or raise TALLY_MAX_RECORDS.'
          );

          const warnings = [
            ...ledgerResponse.repairs,
            ...ledgerWarnings,
            ...voucherResponse.repairs,
            ...voucherWarnings,
          ];

          if (parties.length === 0) {
            warnings.push(
              `No ledgers were found under ${groups.map((g) => `"${g}"`).join(', ')}. This company may file its parties under different group names — check tally_list_ledgers for the groups actually in use.`
            );
          }

          return {
            period,
            groupsUsed: groups,
            ...paginate(rows, pagination, warnings),
          };
        })
    );
  }
}

/**
 * Index bill allocations by party ledger name.
 *
 * Bill references hang off the ledger entry, so the party is taken from the
 * entry's own ledger name rather than the voucher's party field — on a journal
 * adjusting several parties they differ, and using the voucher-level party
 * would attribute one party's bills to another.
 */
function collectBills(
  vouchers: readonly { entries: { ledgerName: string; nested?: Record<string, { fields: Record<string, string> }[]> }[] }[]
): Map<string, Record<string, string>[]> {
  const byParty = new Map<string, Record<string, string>[]>();

  for (const voucher of vouchers) {
    for (const entry of voucher.entries) {
      const bills = entry.nested?.['BILLALLOCATIONS.LIST'] ?? [];
      if (bills.length === 0) continue;

      const key = entry.ledgerName.toLowerCase();
      const existing = byParty.get(key) ?? [];
      existing.push(...bills.map((bill) => bill.fields));
      byParty.set(key, existing);
    }
  }

  return byParty;
}
