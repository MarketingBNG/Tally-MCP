import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  companySchema,
  dateRangeSchema,
  PERIOD_NOTE,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../../schemas/common.js';
import {
  runTool,
  whole,
  type ToolDeps,
} from '../toolResult.js';

/**
 * `tally_test_vouchers`: define a voucher population, then run a procedure over it.
 *
 * Eight tests behind one tool, because that sentence is what all eight are. They
 * share the population filter, they share the exclusion rules, and they share
 * the single Tally fetch — so eight tools would have meant eight copies of the
 * population logic and eight chances for them to drift apart, which is the worst
 * possible failure here: two tests disagreeing about what "the journals in
 * March" means, with no error raised.
 *
 * ## What this tool does NOT produce
 *
 * Findings. Every test returns CANDIDATES FOR REVIEW. A round-numbered journal
 * is not an error, a weekend date is not misconduct, and a Benford deviation is
 * not evidence of anything on its own. The output says so, and it says so per
 * candidate rather than once in a preamble that a summary can drop.
 *
 * That is not diplomatic hedging — it is the accuracy rule. Describing a flagged
 * voucher as a problem states something about the data that the data does not
 * support, and a workpaper carrying that description is wrong in a way that is
 * very hard to catch later.
 */
import { executeVoucherTest } from './run.js';
import { CANDIDATE_NOTE, TEST_VALUES } from './population.js';

/**
 * The `tally_test_vouchers` registration: schema, description, dispatch.
 *
 * Split out of testVouchers.ts at 908 lines. The description is long by design —
 * it is what stops a candidate list being read as a finding list.
 */

const DESCRIPTION = [
  'Run one audit procedure over the vouchers in a period. Screening and analytical tests only — ' +
    'this reads nothing that the other voucher tools cannot, and computes everything itself.',
  '',
  'IT RETURNS CANDIDATES FOR REVIEW, NOT FINDINGS. Every entry that comes back is a voucher ' +
    'worth reading, together with the reason it was picked. None of these tests can establish ' +
    'that anything is wrong: a round amount, a weekend date, a repeated amount and a Benford ' +
    'deviation are all ordinary in ordinary books. Report them as "flagged because X", never as ' +
    'errors, irregularities or red flags, and never total them up as though the count meant ' +
    'something. If a summary of this output drops the word "candidate", the summary is wrong.',
  '',
  'TESTS (`test`):',
  '- journal_screen: manual journals carrying any of four attributes — at or above `threshold`, ' +
    'an exact multiple of `roundMultipleOf`, no narration, or dated a weekend. Journals are the ' +
    'highest-risk population in a ledger because they are what a person wrote by hand rather ' +
    'than what a business process produced. Reasons arrive together per voucher, because they ' +
    'compound: a large round unexplained weekend journal is a different proposition from a ' +
    'large one.',
  '- benford: leading-digit distribution of voucher amounts against Benford expectation, with ' +
    "the mean absolute deviation and Nigrini's conformity band. `benfordDigits: 2` (the " +
    'default) is the more sensitive test; 1 is the one most readers recognise. Needs about 300 ' +
    'amounts to mean anything and says so below that. Conformity is NOT assurance — a ' +
    'misstatement large enough to matter can leave the digit distribution untouched.',
  '- sample: a reproducible sample. Returns the seed, so the same sample can be drawn again — ' +
    'which is what makes it usable as a workpaper. `sampleMethod: random` (default) gives every ' +
    'voucher an equal chance; `systematic` takes every kth in date order, which is cheaper to ' +
    'explain but biased against anything periodic in the data; `monetary_unit` selects with ' +
    'probability proportional to amount, so large vouchers are near-certain to be picked and ' +
    'the effort goes where the value is. Monetary-unit is the usual choice for SUBSTANTIVE ' +
    'testing of overstatement, and the wrong choice for completeness — an omitted or ' +
    'understated item carries fewer monetary units and is correspondingly less likely to be ' +
    'reached. It also reports the sampling interval and which selections were certainties.',
  '- duplicates: groups sharing party, amount AND date exactly. All three are required, because ' +
    'two invoices to one party for one amount on two different days is ordinary trade. Vouchers ' +
    'missing a party, amount or date are not grouped and their count is reported — an unknown ' +
    'cannot be shown to match another unknown.',
  '- round_numbers: amounts that are exact multiples of `roundMultipleOf`. Roundness is scale- ' +
    'relative, which is why the multiple is a parameter: 1,000 is unremarkable on a company ' +
    'transacting in lakhs.',
  '- cutoff: vouchers dated within `cutoffDays` of either end of the period. Proximity to the ' +
    'boundary, not evidence about it — establishing whether goods moved before year end needs ' +
    'despatch documents, which TallyPrime does not hold.',
  '- late_entry: vouchers last WRITTEN long after the date they carry, or written after the ' +
    'period closed. This is the only entry-timing evidence available: TallyPrime Edit Log has ' +
    'no report ID over this interface and its EnteredBy/AlteredBy fields come back empty, so ' +
    'this reads `UpdatedDateTime` instead. TWO REASONS are reported — written after the period ' +
    'end (dated inside the year, written after it closed, which is the case cut-off testing is ' +
    'aimed at) and a lag of at least `lateEntryMinLagDays` days (default 30). Read ' +
    '`lagDistribution` before choosing a threshold: books written up monthly show a 30-day lag ' +
    'on nearly everything and nothing is wrong. IT IS THE LAST WRITE, of unknown authorship — a ' +
    'voucher entered late and one entered on time then altered later are indistinguishable, and ' +
    'nothing here says who did either. It is NOT an Edit Log, NOT an audit trail, and cannot ' +
    'support CARO Rule 11(g). On a company that does not stamp its vouchers the field arrives as ' +
    'all zeros and this test FAILS with TALLY_UNSUPPORTED_OPERATION rather than reporting that ' +
    'nothing was found.',
  '- related_party: vouchers transacted with a related party. Seeded from TallyPrime own ' +
    "`IsRelatedParty` ledger flag, and extended by the `relatedParties` list you supply. " +
    'READ THE OUTPUT ON THIS ONE: a ledger reading false means "not marked in Tally", never "not ' +
    'a related party" — relatedness under AS 18 / Ind AS 24 is a legal determination about ' +
    'directors, relatives, key management personnel and common control, and a company that has ' +
    'never ticked the box has every ledger reading false. So an empty result with no ' +
    '`relatedParties` supplied is evidence about the flag, not about the company. Returns TWO ' +
    'things: `candidates`, the matching vouchers, and `byParty`, the AS 18 / Ind AS 24 ' +
    'disclosure table — one row per party with the nature of dealings by voucher type, the ' +
    'aggregate transacted, and the balance outstanding at period end. The party rows do NOT sum ' +
    'to a company total and are not netted; both are deliberate and both are stated in the ' +
    'output.',
  '- weekend: vouchers DATED on a Saturday or Sunday. Read the two limits in the output: this is ' +
    'the voucher date, not the date it was keyed in, so it is NOT the out-of-hours posting test ' +
    'an auditor wants — that needs the Edit Log, which this connector cannot currently reach. ' +
    'And Saturday/Sunday is an assumption that is simply wrong for a business trading Saturdays.',
  '',
  'THE POPULATION, and why it is reported back to you: every test states how many vouchers it ' +
    'started from and what was left out. Cancelled and optional vouchers are always excluded. ' +
    'Sales and purchase ORDERS are always excluded — they carry no ledger entries, so they would ' +
    'inflate a count without contributing an amount, and an order in an audit sample is a ' +
    'non-transaction. Stock-only vouchers (delivery and receipt notes) are excluded from ' +
    'amount-based tests for the same reason. Filters — voucherType, ledger, party, minAmount, ' +
    'maxAmount, query — narrow the population further and their effect is counted separately.',
  '',
  'A CONTAMINATED POPULATION INVALIDATES THE RESULT, which is why the counts are not decoration. ' +
    'A Benford test over a population including orders is measuring something other than the ' +
    "company's transactions, and it will still return a confident-looking conformity band.",
  '',
  PERIOD_NOTE,
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

export function registerVoucherTestTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_test_vouchers',
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        test: z
          .enum(TEST_VALUES)
          .describe(
            'Which procedure to run. Required — the seven answer different questions and ' +
              'defaulting would answer one the caller did not ask.'
          ),
        ...dateRangeSchema,
        company: companySchema,
        voucherType: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Restrict the population to this exact voucher type, case-insensitive. Type names ' +
              'are company-specific — check tally_get_masters type "voucherType" first, because ' +
              'a guessed name silently returns an empty population rather than an error.'
          ),
        ledger: z
          .string()
          .min(1)
          .optional()
          .describe('Restrict to vouchers with an entry against this ledger (substring match).'),
        party: z
          .string()
          .min(1)
          .optional()
          .describe('Restrict to vouchers whose party ledger matches (substring match).'),
        query: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Restrict to vouchers matching this text in the number, party, narration or entry ' +
              'ledger names.'
          ),
        minAmount: z
          .number()
          .optional()
          .describe('Restrict to vouchers whose largest entry is at least this amount.'),
        maxAmount: z
          .number()
          .optional()
          .describe('Restrict to vouchers whose largest entry is at most this amount.'),
        threshold: z
          .string()
          .regex(/^\d+(\.\d+)?$/, 'Give the threshold as a plain positive number, e.g. "250000".')
          .optional()
          .describe(
            'journal_screen only: amount at or above which a journal is flagged on size alone. ' +
              'Normally your materiality figure from tally_calculate_materiality. Omitted means ' +
              'size is not tested — no default is invented, because materiality is a judgement ' +
              'and not a property of the data.'
          ),
        roundMultipleOf: z
          .number()
          .positive()
          .optional()
          .describe(
            'round_numbers and journal_screen: the multiple that counts as round. Default 1000. ' +
              'Set it to the scale the company actually transacts in.'
          ),
        cutoffDays: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('cutoff only: how many days from each end of the period count. Default 7.'),
        lateEntryMinLagDays: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            'late_entry only: flag a voucher when it was last written at least this many days ' +
              'after the date it carries. Default 30. Vouchers written after the period closed ' +
              'are flagged whatever this is set to, since that needs no threshold. Set it from ' +
              'the `lagDistribution` in a first run — the right value depends on how often this ' +
              'company writes its books up.'
          ),
        sampleSize: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('sample only: how many vouchers to select. Default 25.'),
        sampleSeed: z
          .string()
          .min(1)
          .optional()
          .describe(
            'sample only: the seed. Pass the seed from an earlier run to reproduce that exact ' +
              'sample. Default "tally-mcp" — a FIXED default, deliberately, so an unseeded call ' +
              'is still reproducible; there is no unseeded randomness anywhere in this tool.'
          ),
        sampleMethod: z
          .enum(['random', 'systematic', 'monetary_unit'])
          .optional()
          .describe('sample only: default "random". See the tool description for the tradeoff.'),
        benfordDigits: z
          .union([z.literal(1), z.literal(2)])
          .optional()
          .describe('benford only: 1 for first-digit, 2 (default) for first-two-digit.'),
        relatedParties: z
          .array(z.string().min(1))
          .max(1000)
          .optional()
          .describe(
            'related_party only: ledger names you have determined to be related parties, ' +
              'matched case-insensitively and exactly. Added to whatever TallyPrime own ' +
              '`IsRelatedParty` flag already marks. Supply this from the client register — the ' +
              'flag alone is a seed, not a complete list, and this tool cannot make the legal ' +
              'determination for you.'
          ),
      }),
    },
    async (args) =>
      runTool('tally_test_vouchers', deps, async () => {
        const executed = await executeVoucherTest(deps, args);
        return whole(
          {
            test: executed.test,
            period: executed.period,
            population: executed.population,
            ...executed.payload,
            candidateNote: CANDIDATE_NOTE,
            warnings: executed.warnings,
          },
          executed.rows
        );
      })
  );
}
