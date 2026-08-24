import { z } from 'zod';
import { Decimal } from 'decimal.js';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  companySchema,
  dateRangeSchema,
  PERIOD_NOTE,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import { resolvePeriodForCompany, runTool, whole, type ToolDeps } from './toolResult.js';
import { fetchLedgers } from './ledgers.js';
import { fetchGroupsForScoping } from './groups.js';
import { ledgersUnderGroups } from '../model/groupTree.js';
import { fetchVouchers } from './vouchers.js';

/**
 * `tally_get_fixed_assets`: the movement schedule for the fixed asset ledgers.
 *
 * ## What this is, and what it deliberately is not
 *
 * It is a movement schedule: opening balance, additions, disposals, closing
 * balance, per asset ledger, with the additions and disposals traced to the
 * vouchers that caused them.
 *
 * It is NOT a fixed asset register, and the difference matters. A register
 * holds the acquisition date, the cost, the accumulated depreciation, the
 * useful life and the rate for every individual asset. TallyPrime's ledger
 * masters hold none of that: an asset ledger is one running balance, and
 * whether that balance is gross cost or net of depreciation depends entirely on
 * whether the company chose to keep accumulated depreciation in a separate
 * ledger. This server cannot tell which, and does not guess.
 *
 * So no depreciation is recomputed here — not against Schedule II of the
 * Companies Act, not against the Income Tax rates, not at all. Depreciation
 * charged in the period is REPORTED, as it was posted. Recomputing it would
 * need the useful life and the in-use date per asset, and inventing those to
 * produce a plausible-looking number is exactly how a wrong depreciation charge
 * ends up in a signed set of accounts.
 *
 * ## The control that makes it worth running
 *
 * Opening + additions − disposals should equal closing. Both sides come from
 * different places — the balances from the ledger masters, the movements from
 * the voucher entries — so agreement is real evidence and disagreement is a
 * finding. Every row reports whether it ties, and by how much when it does not.
 */

const NO_RECOMPUTATION_NOTICE =
  'DEPRECIATION IS REPORTED, NEVER RECOMPUTED. What comes back is what was posted. No Schedule ' +
  'II rate, no Income Tax rate and no useful life is applied, because TallyPrime does not hold ' +
  'the acquisition date, the in-use date or the life of any individual asset — an asset ledger ' +
  'is one running balance. If asked whether depreciation is correct, say what was charged, say ' +
  'that recomputing it needs the asset register, and do not produce a figure.';

const NOT_A_REGISTER_NOTICE =
  'THIS IS NOT A FIXED ASSET REGISTER. Each row is a LEDGER, which may hold one asset or a ' +
  'hundred. Whether a balance is gross cost or net of depreciation depends on whether the ' +
  'company keeps accumulated depreciation separately, and that cannot be determined from here. ' +
  'Check the grouping before describing any figure as cost or as written-down value.';

const DESCRIPTION = [
  'Fixed asset movement schedule: opening, additions, disposals and closing per asset ledger, ' +
    'with the additions and disposals traced back to vouchers.',
  '',
  'WHEN TO USE: for the fixed assets section of an audit — to see what was bought and sold in ' +
    'the period, and to test that the movements explain the change in balance.',
  '',
  'THE CONTROL IT PERFORMS: opening + additions − disposals should equal closing. The balances ' +
    'come from the ledger masters and the movements from the voucher entries, so these are two ' +
    'independent sources and agreement between them is evidence. Every row carries `ties` and, ' +
    'where it does not tie, `difference`. A row that does not tie is the finding — start there.',
  '',
  'RETURNS: one row per ledger under the asset groups, plus the depreciation charged in the ' +
    'period, reported separately. Additions and disposals are determined by the SIDE of each ' +
    'entry (debit adds, credit disposes), not by the sign of the amount, so the result does not ' +
    "depend on TallyPrime's balance-sign convention.",
  '',
  NOT_A_REGISTER_NOTICE,
  '',
  NO_RECOMPUTATION_NOTICE,
  '',
  PERIOD_NOTE,
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

/** Groups holding fixed assets. Overridable — companies rename and re-nest them. */
const DEFAULT_ASSET_GROUPS = ['Fixed Assets'];

/**
 * How a depreciation ledger is recognised.
 *
 * By NAME, which is weak and is disclosed as weak. Tally has no flag marking a
 * ledger as depreciation, so the alternative to matching the word is not
 * matching at all. A company that names the account "Amortisation" or
 * "Wear and tear" will be missed, which is why the fragment is a parameter.
 */
const DEFAULT_DEPRECIATION_HINTS = ['deprecia', 'amortis', 'amortiz'];

export function registerFixedAssetTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_get_fixed_assets',
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        company: companySchema,
        ...dateRangeSchema,
        assetGroups: z
          .array(z.string().min(1))
          .optional()
          .describe(
            `Groups holding the asset ledgers. Defaults to ${DEFAULT_ASSET_GROUPS.map((g) => `"${g}"`).join(', ')}. ` +
              'Check tally_get_masters type "group" if this company nests them differently — a ' +
              'wrong group name returns an empty schedule rather than an error.'
          ),
        depreciationHints: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Lower-case fragments that identify a depreciation ledger by name. Defaults to ' +
              `${DEFAULT_DEPRECIATION_HINTS.map((h) => `"${h}"`).join(', ')}. Name matching is the only route available — ` +
              'TallyPrime has no flag for it — so override this if the company calls the account ' +
              'something else.'
          ),
      }),
    },
    async (args) =>
      runTool('tally_get_fixed_assets', deps, async () => {
        const groups = args.assetGroups ?? [...DEFAULT_ASSET_GROUPS];
        const hints = (args.depreciationHints ?? [...DEFAULT_DEPRECIATION_HINTS]).map((hint) =>
          hint.toLowerCase()
        );
        const period = await resolvePeriodForCompany(
          deps,
          args.fromDate,
          args.toDate,
          args.company
        );
        const [{ ledgers, warnings: ledgerWarnings }, { groups: chart, warnings: groupWarnings }] =
          await Promise.all([fetchLedgers(deps, args.company), fetchGroupsForScoping(deps, args.company)]);
        const { vouchers, warnings: voucherWarnings } = await fetchVouchers(
          deps,
          args.company,
          period
        );

        // At or under the requested groups. Fixed assets are routinely filed
        // in sub-groups by class, so the direct-parent match this replaces
        // missed most registers that bother to organise themselves.
        const { matched: assetLedgers, warnings: assetGroupWarnings } = ledgersUnderGroups(
          ledgers,
          chart,
          groups
        );
        const assetNames = new Map(
          assetLedgers.map((ledger) => [ledger.name.toLowerCase(), ledger.name])
        );

        // Movements, accumulated per asset ledger from the voucher entries.
        interface Movement {
          additions: Decimal;
          disposals: Decimal;
          additionVouchers: MovementVoucher[];
          disposalVouchers: MovementVoucher[];
        }
        interface MovementVoucher {
          date: string | null;
          voucherType: string | null;
          voucherNumber: string | null;
          party: string | null;
          amount: string;
        }
        const movements = new Map<string, Movement>();
        const depreciation: MovementVoucher[] = [];
        let depreciationTotal = new Decimal(0);

        for (const voucher of vouchers) {
          if (voucher.isCancelled || voucher.isOptional) continue;
          for (const entry of voucher.entries) {
            if (entry.amount === null) continue;
            const key = entry.ledgerName.toLowerCase();
            const value = new Decimal(entry.amount.amount).abs();

            if (hints.some((hint) => key.includes(hint))) {
              // Depreciation charged: the debit to the expense account.
              if (entry.side === 'debit') {
                depreciationTotal = depreciationTotal.plus(value);
                depreciation.push({
                  date: voucher.date,
                  voucherType: voucher.voucherType,
                  voucherNumber: voucher.voucherNumber,
                  party: voucher.partyLedgerName,
                  amount: value.toFixed(),
                });
              }
              continue;
            }

            if (!assetNames.has(key)) continue;

            const movement = movements.get(key) ?? {
              additions: new Decimal(0),
              disposals: new Decimal(0),
              additionVouchers: [],
              disposalVouchers: [],
            };
            const row: MovementVoucher = {
              date: voucher.date,
              voucherType: voucher.voucherType,
              voucherNumber: voucher.voucherNumber,
              party: voucher.partyLedgerName,
              amount: value.toFixed(),
            };
            // SIDE, not sign. An asset is added by a debit and disposed of by a
            // credit regardless of how TallyPrime encodes the balance, and
            // reading the sign instead would invert the whole schedule.
            if (entry.side === 'debit') {
              movement.additions = movement.additions.plus(value);
              movement.additionVouchers.push(row);
            } else {
              movement.disposals = movement.disposals.plus(value);
              movement.disposalVouchers.push(row);
            }
            movements.set(key, movement);
          }
        }

        let untied = 0;
        let balancesUnavailable = 0;

        const schedule = assetLedgers.map((ledger) => {
          const key = ledger.name.toLowerCase();
          const movement = movements.get(key);
          const additions = movement?.additions ?? new Decimal(0);
          const disposals = movement?.disposals ?? new Decimal(0);

          const opening = ledger.openingBalance?.amount ?? null;
          const closing = ledger.closingBalance?.amount ?? null;

          // The tie-out is only meaningful when both balances were readable.
          // A null is reported as unavailable, never defaulted to zero — a
          // fabricated zero would make an untied row look like it tied.
          let ties: boolean | null = null;
          let difference: string | null = null;
          if (opening !== null && closing !== null) {
            // Balances arrive in TallyPrime's own signed encoding, so the
            // movement is compared on absolute magnitudes: the expected change
            // in the asset's carrying amount is additions less disposals.
            const expected = new Decimal(opening).abs().plus(additions).minus(disposals);
            const actual = new Decimal(closing).abs();
            const gap = actual.minus(expected);
            ties = gap.isZero();
            difference = gap.isZero() ? null : gap.toFixed();
            if (!ties) untied += 1;
          } else {
            balancesUnavailable += 1;
          }

          return {
            ledger: ledger.name,
            group: ledger.parent,
            openingBalance: ledger.openingBalance,
            additions: additions.toFixed(),
            disposals: disposals.toFixed(),
            closingBalance: ledger.closingBalance,
            ties,
            difference,
            additionVouchers: movement?.additionVouchers ?? [],
            disposalVouchers: movement?.disposalVouchers ?? [],
          };
        });

        const warnings = [
          ...ledgerWarnings,
          ...voucherWarnings,
          ...groupWarnings,
          ...assetGroupWarnings,
        ];

        if (assetLedgers.length === 0) {
          warnings.push(
            `No ledger sits under ${groups.map((g) => `"${g}"`).join(', ')}. Either this company ` +
              'holds no fixed assets, or it groups them under a different name — check ' +
              'tally_get_masters type "group" before reading this as "no assets".'
          );
        }
        if (untied > 0) {
          warnings.push(
            `${String(untied)} ledger(s) do NOT tie: the movements found in the period do not ` +
              'explain the change from opening to closing balance. Common causes, in order of ' +
              'likelihood: the requested period is not the whole book year, so movements outside ' +
              'it are missing; the opening balance is the book-year opening rather than the ' +
              'start of your period; or a movement was posted through a ledger not in the asset ' +
              'groups. Investigate before treating it as an error in the books.'
          );
        }
        if (balancesUnavailable > 0) {
          warnings.push(
            `${String(balancesUnavailable)} ledger(s) carry NO opening or closing balance in ` +
              'TallyPrime, so no tie-out was attempted. Confirmed live 17 Aug 2026: the balance ' +
              'is absent from the books rather than unreadable over the interface. Those rows ' +
              'are UNTESTED — an unrecorded balance is unknown, not zero, and treating it as ' +
              'zero would turn a blank into a large unexplained movement.'
          );
        }
        warnings.push(
          'THE OPENING BALANCE IS THE BOOK-YEAR OPENING, not the opening of whatever period you ' +
            'asked for. TallyPrime holds one opening balance per ledger. So the tie-out is only ' +
            'meaningful when the requested period IS the company book year; over any shorter ' +
            'period the schedule still shows real additions and disposals, but the arithmetic ' +
            'will not close.'
        );
        if (depreciation.length === 0) {
          warnings.push(
            'NO DEPRECIATION was found in the period. Depreciation ledgers are identified by ' +
              `name (${hints.map((h) => `"${h}"`).join(', ')}) because TallyPrime has no flag for ` +
              'them, so this may mean the company names the account differently rather than that ' +
              'nothing was charged. Pass depreciationHints to widen the match.'
          );
        }

        return whole(
          {
            period,
            assetGroupsUsed: groups,
            schedule,
            depreciation: {
              identifiedByNameFragments: hints,
              totalCharged: depreciationTotal.toFixed(),
              entries: depreciation,
            },
            ledgersInSchedule: schedule.length,
            ledgersNotTying: untied,
            notARegister: NOT_A_REGISTER_NOTICE,
            warnings,
          },
          schedule.length
        );
      })
  );
}
