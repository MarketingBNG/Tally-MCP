import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  companySchema,
  dateRangeSchema,
  paginationSchema,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import { buildVoucherTypeListRequest, UNSCOPED } from '../tally/requests.js';
import { normalizeVoucherTypes } from '../tally/normalize.js';
import { paginate, resolvePagination } from '../utils/pagination.js';
import {
  fromPage,
  resolveCompanyCurrency,
  resolvePeriodForCompany,
  runTool,
  type ToolDeps,
} from './toolResult.js';
import { fetchLedgers } from './ledgers.js';
import { fetchGroupsForScoping } from './groups.js';
import { ledgersUnderGroups } from '../model/groupTree.js';
import { fetchVouchers } from './vouchers.js';
import {
  DEFAULT_MATCH_RULES,
  familyResolver,
  matchParties,
  type GroupMatch,
  type Match,
  type MatchSide,
  type PartyItem,
  type VoucherFamily,
} from '../model/partyMatching.js';

/**
 * `tally_match_parties`: debtor and creditor matching, done on this machine.
 *
 * Every voucher of the period is read and matched here; only the result goes
 * back to the conversation, a page at a time, with totals that let the reader
 * confirm every row arrived. Nothing is written to disk — the Excel is built in
 * the conversation from these pages. See src/model/partyMatching.ts for the
 * rules and why they are applied in that order.
 */

const VIEWS = [
  'summary',
  'matches',
  'grouped_matches',
  'unmatched_bills',
  'unmatched_settlements',
  'bills_without_party',
] as const;
type View = (typeof VIEWS)[number];

const DESCRIPTION = [
  "Match each party's sales and purchase bills against the receipts and payments that settled " +
    'them, over a whole period, WITHOUT passing the vouchers through the conversation. The ' +
    'matching runs on the computer that holds the books; this returns the result.',
  '',
  'USE THIS instead of reading vouchers or exported CSVs page by page and matching them ' +
    'yourself. A year of vouchers does not fit through the conversation, and a match over a ' +
    'population with rows missing reports bills as unmatched when their receipt simply never ' +
    'arrived.',
  '',
  'RULES (all adjustable): same party; settlement dated from `daysBefore` (10) days before the ' +
    'bill to `daysAfter` (45) after; EXACT within `exactTolerance` (1) tried for every bill ' +
    'first, then PROBABLE within `probableTolerance` (35); each receipt or payment used ' +
    'once; smallest difference wins, then nearest date. THEN GROUPED: a receipt or payment ' +
    'still unused is tried against a run of that party’s oldest open bills, in date order, ' +
    'that adds up to it (exact tolerance first, then probable) — one payment clearing several ' +
    'bills. Debtors: Sales against Receipt. ' +
    'Creditors: Purchase against Payment, including custom types built on those. Parties are ' +
    'ledgers at or under Sundry Debtors / Sundry Creditors unless `debtorGroups` / ' +
    '`creditorGroups` say otherwise. Tolerances are in the currency of the company.',
  '',
  'EVERY MATCH IS A CANDIDATE, never a confirmed settlement: two equal bills a week apart are ' +
    'indistinguishable here. Present matches as "candidate — verify against the bank or card ' +
    'statement", and probable ones as needing review.',
  '',
  'VIEWS — call `summary` first, then page through the others:',
  '- `summary`: totals, and one row per party with its Tally closing balance, billed, settled, ' +
    'matched and unmatched amounts. Totals state how many rows each other view holds.',
  '- `matches`: each bill beside the receipt/payment matched to it, exact or probable.',
  '- `grouped_matches`: one payment covering several bills — one row per bill, sharing a ' +
    '`group` number, with the payment repeated on each row and the group total.',
  '- `unmatched_bills`: bills with no settlement found — what keeps balances open.',
  '- `unmatched_settlements`: receipts/payments set against no bill — advances, on-account ' +
    'payments, or entries posted to the wrong party.',
  '- `bills_without_party`: sales/purchase vouchers with no debtor or creditor ledger at all, ' +
    'which cannot be matched to anyone.',
  '',
  'COMPLETENESS: page until `hasMore` is false, and check your row count against `total`. ' +
    'Building a spreadsheet from a partial set of pages presents a partial match as a whole one. ' +
    'Pages come from the same computation while the cache is warm, so they are consistent.',
  '',
  'Amounts are in the company currency (`currency`), two decimals, always positive; `difference` is settlement minus ' +
    'bill; `daysFromBill` is negative for a payment made before the bill.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

/** Hundredths of the company currency, back to a two-decimal amount. */
const rupees = (paise: number): string => (paise / 100).toFixed(2);

const itemRow = (item: PartyItem): Record<string, unknown> => ({
  side: item.side,
  party: item.party,
  date: item.date,
  voucherType: item.voucherType,
  voucherNumber: item.voucherNumber,
  amount: rupees(item.paise),
  narration: item.narration,
});

const matchRow = (match: Match): Record<string, unknown> => ({
  side: match.bill.side,
  party: match.bill.party,
  kind: match.kind,
  billDate: match.bill.date,
  billType: match.bill.voucherType,
  billNumber: match.bill.voucherNumber,
  billAmount: rupees(match.bill.paise),
  settlementDate: match.settlement.date,
  settlementType: match.settlement.voucherType,
  settlementNumber: match.settlement.voucherNumber,
  settlementAmount: rupees(match.settlement.paise),
  difference: rupees(match.differencePaise),
  daysFromBill: match.daysFromBill,
  settlementNarration: match.settlement.narration,
  status: match.kind === 'exact' ? 'candidate — verify' : 'probable — review',
});

/** One row per bill of a grouped match, numbered so the rows of one group sit together. */
const groupRows = (groups: readonly GroupMatch[]): Record<string, unknown>[] =>
  groups.flatMap((group, index) =>
    group.bills.map((bill) => ({
      group: index + 1,
      side: bill.side,
      party: bill.party,
      kind: group.kind,
      billDate: bill.date,
      billType: bill.voucherType,
      billNumber: bill.voucherNumber,
      billAmount: rupees(bill.paise),
      billsInGroup: group.bills.length,
      groupTotal: rupees(group.billsPaise),
      settlementDate: group.settlement.date,
      settlementType: group.settlement.voucherType,
      settlementNumber: group.settlement.voucherNumber,
      settlementAmount: rupees(group.settlement.paise),
      difference: rupees(group.differencePaise),
      status: group.kind === 'grouped_exact' ? 'candidate — verify' : 'probable — review',
    }))
  );

/** A voucher type's family, from its built-in parent. */
async function voucherFamilies(
  deps: ToolDeps,
  company: string | undefined
): Promise<{ familyOf: (type: string | null) => VoucherFamily; warnings: string[] }> {
  const response = await deps.client.send(
    buildVoucherTypeListRequest({ company: company ?? UNSCOPED }),
    'standard'
  );
  const { data, warnings } = normalizeVoucherTypes(response.body);
  return {
    familyOf: familyResolver(data),
    warnings: [...response.repairs, ...warnings],
  };
}

export function registerPartyMatchingTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_match_parties',
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        view: z.enum(VIEWS).optional().describe('Which part of the result. Defaults to `summary`.'),
        side: z
          .enum(['debtors', 'creditors', 'both'])
          .optional()
          .describe('Which parties to match. Defaults to both.'),
        exactTolerance: z
          .number()
          .min(0)
          .max(1000)
          .optional()
          .describe('Largest difference, in the company currency, called exact. Default 1.'),
        probableTolerance: z
          .number()
          .min(0)
          .max(100000)
          .optional()
          .describe('Largest difference, in the company currency, called probable. Default 35.'),
        daysBefore: z
          .number()
          .int()
          .min(0)
          .max(366)
          .optional()
          .describe('Days before the bill a settlement may be dated. Default 10.'),
        daysAfter: z
          .number()
          .int()
          .min(0)
          .max(731)
          .optional()
          .describe('Days after the bill a settlement may be dated. Default 45.'),
        debtorGroups: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Groups holding customer ledgers, sub-groups included. Default ["Sundry Debtors"].'
          ),
        creditorGroups: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Groups holding supplier ledgers, sub-groups included. Default ["Sundry Creditors"].'
          ),
        company: companySchema,
        ...dateRangeSchema,
        ...paginationSchema,
      }),
    },
    async (args) =>
      runTool('tally_match_parties', deps, async () => {
        const pagination = resolvePagination(args.page, args.pageSize);
        const view: View = args.view ?? 'summary';
        const sides: MatchSide[] =
          args.side === 'debtors'
            ? ['debtors']
            : args.side === 'creditors'
              ? ['creditors']
              : ['debtors', 'creditors'];
        const rules = {
          exactTolerance: args.exactTolerance ?? DEFAULT_MATCH_RULES.exactTolerance,
          probableTolerance: args.probableTolerance ?? DEFAULT_MATCH_RULES.probableTolerance,
          daysBefore: args.daysBefore ?? DEFAULT_MATCH_RULES.daysBefore,
          daysAfter: args.daysAfter ?? DEFAULT_MATCH_RULES.daysAfter,
        };
        const period = await resolvePeriodForCompany(
          deps,
          args.fromDate,
          args.toDate,
          args.company
        );

        const [{ ledgers, warnings: ledgerWarnings }, { groups, warnings: groupWarnings }] =
          await Promise.all([
            fetchLedgers(deps, args.company),
            fetchGroupsForScoping(deps, args.company),
          ]);
        const debtorGroups = args.debtorGroups ?? ['Sundry Debtors'];
        const creditorGroups = args.creditorGroups ?? ['Sundry Creditors'];
        const debtors = ledgersUnderGroups(ledgers, groups, debtorGroups);
        const creditors = ledgersUnderGroups(ledgers, groups, creditorGroups);
        const currencyWarnings: string[] = [];
        const currency = await resolveCompanyCurrency(deps, args.company, currencyWarnings);
        const families = await voucherFamilies(deps, args.company);
        const { vouchers, warnings: voucherWarnings } = await fetchVouchers(
          deps,
          args.company,
          period
        );

        const result = matchParties({
          vouchers,
          debtors: new Set(debtors.matched.map((ledger) => ledger.name.trim().toLowerCase())),
          creditors: new Set(creditors.matched.map((ledger) => ledger.name.trim().toLowerCase())),
          familyOf: families.familyOf,
          rules,
          sides,
        });

        const warnings = [
          ...ledgerWarnings,
          ...groupWarnings,
          ...debtors.warnings,
          ...creditors.warnings,
          ...families.warnings,
          ...voucherWarnings,
          ...currencyWarnings,
        ];

        const counts = {
          matches: result.matches.length,
          exact: result.matches.filter((match) => match.kind === 'exact').length,
          probable: result.matches.filter((match) => match.kind === 'probable').length,
          groupedSettlements: result.groupMatches.length,
          groupedBills: result.groupMatches.reduce((n, group) => n + group.bills.length, 0),
          unmatchedBills: result.unmatchedBills.length,
          unmatchedSettlements: result.unmatchedSettlements.length,
          billsWithoutParty: result.billsWithoutParty.length,
          parties: result.parties.length,
        };
        const context = {
          view,
          period,
          currency,
          rules,
          sides,
          debtorGroups,
          creditorGroups,
          counts,
        };

        switch (view) {
          case 'matches':
            return fromPage(paginate(result.matches.map(matchRow), pagination, warnings), context);
          case 'grouped_matches':
            return fromPage(
              paginate(groupRows(result.groupMatches), pagination, warnings),
              context
            );
          case 'unmatched_bills':
            return fromPage(
              paginate(result.unmatchedBills.map(itemRow), pagination, warnings),
              context
            );
          case 'unmatched_settlements':
            return fromPage(
              paginate(result.unmatchedSettlements.map(itemRow), pagination, warnings),
              context
            );
          case 'bills_without_party':
            return fromPage(
              paginate(result.billsWithoutParty.map(itemRow), pagination, warnings),
              context
            );
          default: {
            const closing = new Map(
              ledgers.map((ledger) => [ledger.name.trim().toLowerCase(), ledger.closingBalance])
            );
            const rows = result.parties.map((party) => ({
              side: party.side,
              party: party.party,
              tallyClosingBalance: closing.get(party.party.trim().toLowerCase())?.amount ?? null,
              bills: party.bills,
              billed: rupees(party.billedPaise),
              settlements: party.settlements,
              settled: rupees(party.settledPaise),
              exactMatches: party.exactMatches,
              probableMatches: party.probableMatches,
              groupedSettlements: party.groupedSettlements,
              groupedBills: party.groupedBills,
              unmatchedBills: party.unmatchedBills,
              unmatchedBillsAmount: rupees(party.unmatchedBillsPaise),
              unmatchedSettlements: party.unmatchedSettlements,
              unmatchedSettlementsAmount: rupees(party.unmatchedSettlementsPaise),
            }));
            return fromPage(paginate(rows, pagination, warnings), {
              ...context,
              note:
                "tallyClosingBalance is Tally's own signed figure (debit negative); billed and " +
                'settled cover only this period, so they need not reconcile to it when the party ' +
                'had an opening balance.',
            });
          }
        }
      })
  );
}
