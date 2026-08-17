import { z } from 'zod';
import { Decimal } from 'decimal.js';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  companySchema,
  paginationSchema,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import { paginate, resolvePagination } from '../utils/pagination.js';
import { fromPage, runTool, type ToolDeps } from './toolResult.js';
import { fetchLedgers } from './ledgers.js';

/**
 * `tally_get_confirmation_list`: the parties to send balance confirmations to.
 *
 * ## Why this is a selection tool, not a letter generator
 *
 * Under SA 505 the auditor controls the confirmation process: who is selected,
 * what is sent, and — critically — that the request goes out and comes back
 * without passing through the client's hands. None of that is something this
 * server can do or should appear to do. What it CAN do is the part that is
 * mechanical and error-prone by hand: list the parties, their balances, and
 * whether each has an address or contact recorded to send anything to.
 *
 * So this returns a selection list with the balance to be confirmed and the
 * contact details Tally holds. It does not draft a letter, does not decide the
 * sample, and does not track responses.
 *
 * ## The balance is the book balance, and that is the point
 *
 * A confirmation asks the counterparty to agree the balance PER THE BOOKS. The
 * figure here is exactly what the ledger says, unadjusted — no netting across
 * a party with both a debit and a credit account, no rounding. A confirmation
 * sent for an adjusted figure confirms the adjustment rather than the books.
 */

const PROCESS_NOTICE =
  'THE CONFIRMATION PROCESS IS THE AUDITOR\'S, NOT THIS TOOL\'S. Under SA 505 the auditor must ' +
  'control the sending and receiving of requests — the client must not handle them. This tool ' +
  'only lists candidates and their recorded balances. It does not draft requests, does not ' +
  'decide the sample, and cannot know whether a reply is genuine. Selecting which parties to ' +
  'circularise is a judgement about risk and coverage, not a threshold.';

const NO_CONTACT_NOTICE =
  'A PARTY WITH NO ADDRESS OR PHONE cannot be circularised, and that is itself worth knowing: a ' +
  'material balance owed by a party with no recorded contact details is a finding before it is ' +
  'a logistical problem. Those parties are returned with `contactable: false` rather than ' +
  'filtered out.';

const DESCRIPTION = [
  'List the parties that could be sent a balance confirmation, with the balance per the books ' +
    'and whatever contact details TallyPrime holds.',
  '',
  'WHEN TO USE: when planning a receivables or payables circularisation. Filter with ' +
    '`minimumBalance` to see the parties above a figure you chose, and `direction` to take ' +
    'debit balances (receivables), credit balances (payables) or both.',
  '',
  'RETURNS: one row per party — name, group, the balance to be confirmed as recorded, the side ' +
    'that balance falls on, the contact details held, and `contactable`, which is false when ' +
    'TallyPrime holds no phone or contact name. Rows are ordered by size, largest first, because ' +
    'that is the order coverage is usually built in.',
  '',
  'THE BALANCE IS UNADJUSTED. It is what the ledger says, which is what a confirmation asks the ' +
    'counterparty to agree. Balances are NOT netted across two ledgers for the same party — if a ' +
    'customer is also a supplier, both rows are returned separately, because netting them would ' +
    'ask for agreement to a figure that appears nowhere in either set of books.',
  '',
  PROCESS_NOTICE,
  '',
  NO_CONTACT_NOTICE,
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

const DEFAULT_GROUPS = ['Sundry Debtors', 'Sundry Creditors', 'Accounts Receivable', 'Accounts Payable'];

export function registerConfirmationTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_get_confirmation_list',
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        company: companySchema,
        partyGroups: z
          .array(z.string().min(1))
          .optional()
          .describe(
            `Groups holding the parties. Defaults to ${DEFAULT_GROUPS.map((g) => `"${g}"`).join(', ')}, ` +
              'which covers the common Indian and international namings. A group name this ' +
              'company does not use contributes nothing rather than failing.'
          ),
        direction: z
          .enum(['receivable', 'payable', 'both'])
          .optional()
          .describe(
            'Which side to return. "receivable" takes debit balances, "payable" credit ' +
              'balances, "both" (default) takes either. Determined from the balance itself, not ' +
              'from the group, so a supplier carrying a debit balance — an advance — appears ' +
              'under receivable where it belongs.'
          ),
        minimumBalance: z
          .number()
          .nonnegative()
          .optional()
          .describe(
            'Only parties whose absolute balance is at least this. NO DEFAULT, deliberately: ' +
              'the cut-off for circularisation is an audit judgement about coverage and risk, ' +
              'and a number invented here would look like a recommendation. Omitted returns ' +
              'every party with a non-zero balance.'
          ),
        ...paginationSchema,
      }),
    },
    async (args) =>
      runTool('tally_get_confirmation_list', deps, async () => {
        const groups = args.partyGroups ?? [...DEFAULT_GROUPS];
        const groupSet = new Set(groups.map((group) => group.toLowerCase()));
        const direction = args.direction ?? 'both';
        const pagination = resolvePagination(args.page, args.pageSize);

        // Full fields: the contact details are not in the curated set.
        const { ledgers, warnings } = await fetchLedgers(deps, args.company, true);

        let zeroBalance = 0;
        let unreadableBalance = 0;
        let belowMinimum = 0;
        let uncontactable = 0;

        const rows = ledgers
          .filter((ledger) => groupSet.has((ledger.parent ?? '').toLowerCase()))
          .map((ledger) => {
            const raw = ledger.closingBalance?.amount ?? null;
            if (raw === null) {
              unreadableBalance += 1;
              return null;
            }
            const balance = new Decimal(raw);
            if (balance.isZero()) {
              zeroBalance += 1;
              return null;
            }

            // TallyPrime encodes a debit as negative on these balances, so a
            // receivable — money owed TO the company — is the negative side.
            const side = balance.isNegative() ? 'receivable' : 'payable';
            if (direction !== 'both' && side !== direction) return null;

            const magnitude = balance.abs();
            if (args.minimumBalance !== undefined && magnitude.lessThan(args.minimumBalance)) {
              belowMinimum += 1;
              return null;
            }

            const fields = ledger.fields ?? {};
            const phone = fields.LEDGERPHONE ?? fields.LEDGERMOBILE ?? null;
            const contact = fields.LEDGERCONTACT ?? null;
            const email = fields.EMAIL ?? null;
            const contactable = Boolean(phone ?? contact ?? email);
            if (!contactable) uncontactable += 1;

            return {
              party: ledger.name,
              group: ledger.parent,
              balanceToConfirm: ledger.closingBalance,
              side,
              magnitude: magnitude.toFixed(),
              contact: { name: contact, phone, email },
              contactable,
              gstin: ledger.gstin,
              source: ledger.source,
            };
          })
          .filter((row): row is NonNullable<typeof row> => row !== null)
          .sort((a, b) => new Decimal(b.magnitude).comparedTo(new Decimal(a.magnitude)));

        const allWarnings = [...warnings];
        if (rows.length === 0) {
          allWarnings.push(
            `No party under ${groups.map((g) => `"${g}"`).join(', ')} met the criteria. Check ` +
              'the group names against tally_get_masters type "group" before reading this as ' +
              '"no parties to confirm".'
          );
        }
        if (uncontactable > 0) {
          allWarnings.push(
            `${String(uncontactable)} party/parties have NO phone, contact name or email in ` +
              'TallyPrime and cannot be circularised from what the books hold. They are included ' +
              'with contactable=false rather than dropped — a material balance owed by a party ' +
              'with no contact details is a finding in its own right, and alternative procedures ' +
              'will be needed for them under SA 505.'
          );
        }
        if (unreadableBalance > 0) {
          allWarnings.push(
            `${String(unreadableBalance)} ledger(s) carry NO CLOSING BALANCE in TallyPrime and ` +
              'were left out. Confirmed against live books 17 Aug 2026: this is absent source ' +
              'data — the balance was never filled in — not a failure to read it. It is still ' +
              'not the same as nil: an unrecorded balance is unknown, and a party whose balance ' +
              'is unknown is UNTESTED rather than agreed at zero. On a partially maintained set ' +
              'of books this count can be large, and a confirmation exercise that ignores it ' +
              'covers less than it appears to.'
          );
        }
        allWarnings.push(PROCESS_NOTICE);

        return fromPage(paginate(rows, pagination, allWarnings), {
          partyGroupsUsed: groups,
          direction,
          ...(args.minimumBalance === undefined
            ? { minimumBalance: null }
            : { minimumBalance: args.minimumBalance }),
          excluded: { zeroBalance, noBalanceRecorded: unreadableBalance, belowMinimum },
        });
      })
  );
}
