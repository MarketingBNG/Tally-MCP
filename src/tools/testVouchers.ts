import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { TallyError } from '../tally/TallyError.js';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Voucher } from '../tally/normalize.js';
import { fetchVouchers } from './vouchers.js';
import { fetchLedgers } from './ledgers.js';
import { matchesVoucherFilters } from './voucherFilters.js';
import {
  asCandidate,
  benford,
  findCutOffEntries,
  findDuplicates,
  findLateWritten,
  findRoundNumbers,
  findWeekendDated,
  sampleVouchers,
  screenJournals,
  summariseRelatedParties,
} from '../audit/procedures.js';
import type { RelatedPartySource, SampleMethod } from '../audit/procedures.js';
import {
  companySchema,
  dateRangeSchema,
  PERIOD_NOTE,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import {
  noteEmptyDefaultedPeriod,
  periodWasDefaulted,
  resolvePeriodForCompany,
  runTool,
  whole,
  type ToolDeps,
} from './toolResult.js';

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

/** The population every test starts from, before any test-specific filter. */
interface Population {
  vouchers: Voucher[];
  warnings: string[];
  excluded: {
    cancelled: number;
    optional: number;
    orders: number;
    inventoryOnly: number;
    filteredOut: number;
  };
}

export const TEST_VALUES = [
  'journal_screen',
  'benford',
  'sample',
  'duplicates',
  'round_numbers',
  'cutoff',
  'weekend',
  'late_entry',
  'related_party',
] as const;

export type TestName = (typeof TEST_VALUES)[number];

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

/**
 * Build the population once, with every exclusion counted.
 *
 * `amountBased` is the one axis on which the tests genuinely differ: a
 * stock-only delivery note belongs in a completeness or cut-off question and
 * does not belong in a Benford distribution, because it has no amount to
 * contribute. Rather than let each test decide silently, the flag is explicit
 * and the exclusion is reported.
 */
async function buildPopulation(
  deps: ToolDeps,
  args: {
    company?: string;
    voucherType?: string;
    ledger?: string;
    party?: string;
    query?: string;
    minAmount?: number;
    maxAmount?: number;
  },
  period: { fromDate: string; toDate: string },
  amountBased: boolean
): Promise<Population> {
  const { vouchers, warnings } = await fetchVouchers(deps, args.company, period);

  const excluded = { cancelled: 0, optional: 0, orders: 0, inventoryOnly: 0, filteredOut: 0 };
  const kept: Voucher[] = [];

  for (const voucher of vouchers) {
    if (voucher.isCancelled) {
      excluded.cancelled += 1;
      continue;
    }
    if (voucher.isOptional) {
      excluded.optional += 1;
      continue;
    }
    if (voucher.isOrderVoucher) {
      excluded.orders += 1;
      continue;
    }
    if (amountBased && voucher.isInventoryVoucher) {
      excluded.inventoryOnly += 1;
      continue;
    }
    if (
      !matchesVoucherFilters(voucher, {
        ...(args.query === undefined ? {} : { query: args.query }),
        ...(args.voucherType === undefined ? {} : { voucherType: args.voucherType }),
        ...(args.ledger === undefined ? {} : { ledger: args.ledger }),
        ...(args.party === undefined ? {} : { party: args.party }),
        ...(args.minAmount === undefined ? {} : { minAmount: args.minAmount }),
        ...(args.maxAmount === undefined ? {} : { maxAmount: args.maxAmount }),
      })
    ) {
      excluded.filteredOut += 1;
      continue;
    }
    kept.push(voucher);
  }

  return { vouchers: kept, warnings, excluded };
}

/** Turn the exclusion counts into sentences, so nothing is dropped silently. */
function describeExclusions(population: Population, amountBased: boolean): string[] {
  const { excluded } = population;
  const notes: string[] = [];
  if (excluded.cancelled > 0) {
    notes.push(`${String(excluded.cancelled)} cancelled voucher(s) excluded.`);
  }
  if (excluded.optional > 0) {
    notes.push(
      `${String(excluded.optional)} optional voucher(s) excluded — TallyPrime does not post ` +
        'them to the books.'
    );
  }
  if (excluded.orders > 0) {
    notes.push(
      `${String(excluded.orders)} sales/purchase order(s) excluded: an order is a commitment ` +
        'with no ledger entries, so it would inflate the count without contributing an amount.'
    );
  }
  if (amountBased && excluded.inventoryOnly > 0) {
    notes.push(
      `${String(excluded.inventoryOnly)} stock-only voucher(s) (delivery/receipt notes) excluded ` +
        'from this amount-based test: they move inventory without touching accounts, so they ' +
        'have no amount to contribute.'
    );
  }
  if (excluded.filteredOut > 0) {
    notes.push(`${String(excluded.filteredOut)} voucher(s) did not match the filters given.`);
  }
  return notes;
}

/**
 * The population note every test carries.
 *
 * Deliberately per-result rather than only in the tool description: a
 * description is read once when choosing the tool, and this has to survive
 * being quoted out of context into a workpaper.
 */
const CANDIDATE_NOTE =
  'These are CANDIDATES FOR REVIEW, not findings. Each carries the reason it was flagged. ' +
  'Nothing here establishes that a voucher is wrong — describe them as flagged, with the ' +
  'reason, and do not present the count as a number of problems.';

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

/** Everything a run of one procedure produced, before it is shaped for output. */
export interface ExecutedVoucherTest {
  test: TestName;
  period: { fromDate: string; toDate: string };
  population: { tested: number; excluded: Population['excluded'] };
  payload: object;
  rows: number;
  warnings: string[];
  /** The options actually used, defaults resolved. This is what reproduces the run. */
  resolvedOptions: ProcedureOptions;
}

/** The arguments a voucher test accepts, shared by the test tool and the workpaper. */
export interface VoucherTestArgs {
  test: TestName;
  company?: string | undefined;
  fromDate?: string | undefined;
  toDate?: string | undefined;
  voucherType?: string | undefined;
  ledger?: string | undefined;
  party?: string | undefined;
  query?: string | undefined;
  minAmount?: number | undefined;
  maxAmount?: number | undefined;
  threshold?: string | undefined;
  roundMultipleOf?: number | undefined;
  cutoffDays?: number | undefined;
  lateEntryMinLagDays?: number | undefined;
  sampleSize?: number | undefined;
  sampleSeed?: string | undefined;
  sampleMethod?: SampleMethod | undefined;
  benfordDigits?: 1 | 2 | undefined;
  relatedParties?: string[] | undefined;
}

/**
 * Run one procedure end to end: resolve the period, build the population, run
 * the test.
 *
 * EXPORTED so the workpaper tool runs THIS code rather than its own copy. That
 * is the whole basis on which a workpaper can claim to be reproducible — if the
 * document were assembled from figures passed back in by the caller, it would
 * be a transcription of whatever the conversation happened to contain, and a
 * transcription that looks like evidence is worse than no evidence at all.
 * Two code paths would drift, and the document would then disagree with the
 * tool while both claimed the same period.
 */
export async function executeVoucherTest(
  deps: ToolDeps,
  args: VoucherTestArgs
): Promise<ExecutedVoucherTest> {
  const test: TestName = args.test;
  const period = await resolvePeriodForCompany(deps, args.fromDate, args.toDate, args.company);

  // Cut-off, weekend and late_entry ask about DATES, so a stock-only voucher
  // belongs in them; every other test reads an amount, which a stock-only
  // voucher does not have.
  const amountBased = test !== 'cutoff' && test !== 'weekend' && test !== 'late_entry';

  const population = await buildPopulation(
    deps,
    {
      ...(args.company === undefined ? {} : { company: args.company }),
      ...(args.voucherType === undefined ? {} : { voucherType: args.voucherType }),
      ...(args.ledger === undefined ? {} : { ledger: args.ledger }),
      ...(args.party === undefined ? {} : { party: args.party }),
      ...(args.query === undefined ? {} : { query: args.query }),
      ...(args.minAmount === undefined ? {} : { minAmount: args.minAmount }),
      ...(args.maxAmount === undefined ? {} : { maxAmount: args.maxAmount }),
    },
    period,
    amountBased
  );
  const warnings = [
    ...population.warnings,
    ...describeExclusions(population, amountBased),
    // An empty population on a period nobody chose is usually the
    // company's book year not being the current one, not missing data.
    ...(await noteEmptyDefaultedPeriod(
      deps,
      period,
      periodWasDefaulted(args.fromDate, args.toDate),
      population.vouchers.length,
      args.company
    )),
  ];

  // Only fetched for the one test that needs it: the ledger list is a
  // second Tally request, and paying for it on a Benford run would be a
  // cost with no answer attached.
  let flaggedInTally: string[] = [];
  // Closing balances for EVERY ledger, keyed lower-case: the summary needs
  // the year-end balance for any party the caller supplied as well as for
  // the ones Tally flagged, and which of those exist is not known here.
  const ledgerBalances = new Map<string, string | null>();
  if (test === 'related_party') {
    const { ledgers, warnings: ledgerWarnings } = await fetchLedgers(deps, args.company);
    flaggedInTally = ledgers.filter((ledger) => ledger.isRelatedParty).map((ledger) => ledger.name);
    for (const ledger of ledgers) {
      ledgerBalances.set(ledger.name.toLowerCase(), ledger.closingBalance?.amount ?? null);
    }
    warnings.push(...ledgerWarnings);
  }

  const resolvedOptions: ProcedureOptions = {
    roundMultipleOf: args.roundMultipleOf ?? 1000,
    ...(args.threshold === undefined ? {} : { threshold: args.threshold }),
    cutoffDays: args.cutoffDays ?? 7,
    lateEntryMinLagDays: args.lateEntryMinLagDays ?? 30,
    sampleSize: args.sampleSize ?? 25,
    sampleSeed: args.sampleSeed ?? 'tally-mcp',
    sampleMethod: args.sampleMethod ?? 'random',
    benfordDigits: args.benfordDigits ?? 2,
    relatedParties: args.relatedParties ?? [],
    flaggedInTally,
    ledgerBalances,
  };
  const result = runProcedure(test, population.vouchers, period, resolvedOptions);

  return {
    test,
    period,
    population: { tested: population.vouchers.length, excluded: population.excluded },
    payload: result.payload,
    rows: result.rows,
    warnings: [...warnings, ...result.warnings],
    resolvedOptions,
  };
}

export interface ProcedureOptions {
  roundMultipleOf: number;
  threshold?: string;
  cutoffDays: number;
  lateEntryMinLagDays: number;
  sampleSize: number;
  sampleSeed: string;
  sampleMethod: SampleMethod;
  benfordDigits: 1 | 2;
  /** Names the caller determined to be related parties. */
  relatedParties: string[];
  /** Names TallyPrime own IsRelatedParty flag marks. */
  flaggedInTally: string[];
  ledgerBalances: ReadonlyMap<string, string | null>;
}

/** Dispatch to the procedure and shape its result. Pure apart from the inputs. */
function runProcedure(
  test: TestName,
  vouchers: Voucher[],
  period: { fromDate: string; toDate: string },
  options: ProcedureOptions
): { payload: object; rows: number; warnings: string[] } {
  switch (test) {
    case 'journal_screen': {
      // Journals are identified by voucher type NAME containing "journal",
      // which is a weaker rule than it looks and is disclosed as such: a
      // company may name a manual journal type anything at all. The
      // `voucherType` filter is the exact route where the name is known.
      const journals = vouchers.filter((voucher) =>
        (voucher.voucherType ?? '').toLowerCase().includes('journal')
      );
      const candidates = screenJournals(journals, {
        roundMultipleOf: options.roundMultipleOf,
        ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
      });
      const warnings = [
        'JOURNALS WERE IDENTIFIED BY TYPE NAME containing "journal", because TallyPrime has no ' +
          '"is a manual journal" flag. A company that names its manual adjustment type ' +
          'something else — "Adjustment", "Provision", "Contra Entry" — is NOT covered by that ' +
          'match, so an empty result is not evidence there were no manual journals. Check ' +
          'tally_get_masters type "voucherType" for the names this company uses, then re-run ' +
          'with `voucherType` set.',
      ];
      if (options.threshold === undefined) {
        warnings.push(
          'No `threshold` was given, so journals were NOT tested on size. Pass your materiality ' +
            'figure to include the size attribute.'
        );
      }
      if (journals.length === 0 && vouchers.length > 0) {
        warnings.push(
          `None of the ${String(vouchers.length)} vouchers in the population had a type name ` +
            'containing "journal". That is a statement about the type names, not about whether ' +
            'the company posts manual journals.'
        );
      }
      return {
        payload: { journalsInPopulation: journals.length, candidates },
        rows: candidates.length,
        warnings,
      };
    }

    case 'benford': {
      const result = benford(vouchers, options.benfordDigits);
      return {
        payload: { benford: { ...result, warnings: undefined }, distributionOnly: true },
        rows: result.distribution.length,
        warnings: [
          ...result.warnings,
          'A BENFORD RESULT IS NOT A CONCLUSION. Nonconformity is a reason to look at the ' +
            'population, and conformity is not assurance: a misstatement confined to a few ' +
            'entries can be material and still leave the digit distribution intact.',
        ],
      };
    }

    case 'sample': {
      const result = sampleVouchers(
        vouchers,
        options.sampleSize,
        options.sampleSeed,
        options.sampleMethod
      );
      return {
        payload: { sample: { ...result, warnings: undefined } },
        rows: result.selected.length,
        warnings: [
          ...result.warnings,
          `Seed "${result.seed}" and method "${result.method}" reproduce this exact sample over ` +
            'the same population. If the population changes — a different period, different ' +
            'filters, or new vouchers posted since — the same seed gives a DIFFERENT sample, so ' +
            'record the period and filters alongside the seed.',
        ],
      };
    }

    case 'duplicates': {
      const { groups, notComparable } = findDuplicates(vouchers);
      const warnings = [
        'A REPEATED AMOUNT IS NOT A DUPLICATE POSTING. Before treating a group as one, check ' +
          'whether the voucher type prevents duplicate numbering at all — ' +
          'tally_get_masters type "voucherType" reports `preventsDuplicates` per series. Two ' +
          'genuine invoices can share a party, an amount and a date.',
      ];
      if (notComparable > 0) {
        warnings.push(
          `${String(notComparable)} voucher(s) could not be compared because they lacked a ` +
            'party, an amount or a date. They are left out rather than grouped together: an ' +
            'unknown cannot be shown to match another unknown, and grouping them would ' +
            'manufacture duplicates out of missing data.'
        );
      }
      return {
        payload: { duplicateGroups: groups, notComparable },
        rows: groups.length,
        warnings,
      };
    }

    case 'round_numbers': {
      const candidates = findRoundNumbers(vouchers, options.roundMultipleOf);
      return {
        payload: { roundMultipleOf: new Decimal(options.roundMultipleOf).toFixed(), candidates },
        rows: candidates.length,
        warnings: [
          'Round amounts are ordinary in ordinary books — rent, salaries, fixed fees and ' +
            'round-sum advances are all exactly round by design. This test earns its place ' +
            'against estimates and manual journals, not against the whole ledger.',
        ],
      };
    }

    case 'cutoff': {
      const candidates = findCutOffEntries(vouchers, period, options.cutoffDays);
      return {
        payload: { cutoffDays: options.cutoffDays, candidates },
        rows: candidates.length,
        warnings: [
          'PROXIMITY, NOT EVIDENCE. These vouchers are near a period boundary, which is where a ' +
            'wrong-period entry would be if there were one. Establishing whether the ' +
            'transaction belongs in this period needs the despatch or receipt documents, and ' +
            'TallyPrime does not hold those.',
          'This tests the voucher DATE against the period. For the case cut-off testing is ' +
            'really aimed at — an entry dated before year end but keyed in after it — run test ' +
            '"late_entry", which reads when each voucher was last written. Read its limits: it ' +
            'is the last write, of unknown authorship, and it is unavailable on a company that ' +
            'does not stamp its vouchers.',
        ],
      };
    }

    case 'late_entry': {
      const result = findLateWritten(vouchers, period, options.lateEntryMinLagDays);

      /**
       * REFUSE rather than report nothing found.
       *
       * A company that has never stamped its vouchers sends `UpdatedDateTime` as
       * all zeros on every record, so the honest-looking output of this test on
       * such a company is an empty candidate list — indistinguishable from books
       * where every entry was written on the day it is dated. An auditor reading
       * that has been told the opposite of the truth, which is the exact failure
       * this connector has been corrected for twice. So the test fails loudly.
       */
      if (result.stamped === 0 && vouchers.length > 0) {
        throw new TallyError(
          'TALLY_UNSUPPORTED_OPERATION',
          `None of the ${String(vouchers.length)} vouchers in this population carries a write ` +
            'timestamp — TallyPrime returned its all-zero placeholder for every one, so there is ' +
            'nothing to test. This is NOT a result of "no late entries".',
          {
            suggestion:
              'This company does not stamp UpdatedDateTime on its vouchers, and TallyPrime Edit ' +
              'Log is not reachable over this interface, so entry timing cannot be examined ' +
              'here at all. Use the Edit Log inside TallyPrime (if the company has it switched ' +
              'on), or ask the client when the books were written up. Test "cutoff" still tests ' +
              'voucher DATES against the period.',
          }
        );
      }

      const warnings = [
        'THIS IS THE LAST WRITE, NOT THE ENTRY. `UpdatedDateTime` records when the voucher was ' +
          'most recently saved. A voucher keyed in late and a voucher keyed in on time and ' +
          'altered months later are indistinguishable here, and neither says who did it. Present ' +
          'these as entries whose timing is worth asking about.',
        'NOT AN AUDIT TRAIL. This does not show what changed, or that anything changed at all, ' +
          'and it cannot support CARO Rule 11(g) — which needs the Edit Log itself, preserved ' +
          'and untampered. Get that from TallyPrime on screen.',
        'A LAG IS NOT AN IRREGULARITY. Books written up weekly or monthly produce a lag on every ' +
          'voucher in them. Read `lagDistribution` — if the median across the whole population ' +
          'is 40 days, a 40-day lag is this company being itself, and the threshold should be ' +
          'set above it.',
      ];
      if (result.unstamped > 0) {
        warnings.push(
          `${String(result.unstamped)} of ${String(vouchers.length)} voucher(s) carry NO write ` +
            'timestamp and were not tested. They are not absent from the candidate list because ' +
            'they passed — they were never examined. Any statement about "the period" has to be ' +
            'qualified by that count.'
        );
      }
      if (result.undated > 0) {
        warnings.push(
          `${String(result.undated)} voucher(s) had a write timestamp but no readable date of ` +
            'their own, so no lag could be computed for them.'
        );
      }
      if (result.postDated > 0) {
        warnings.push(
          `${String(result.postDated)} voucher(s) were written BEFORE the date they carry — ` +
            'post-dated entries. Counted, not flagged: entering next month rent today is ' +
            'ordinary bookkeeping.'
        );
      }

      return {
        payload: {
          minLagDays: options.lateEntryMinLagDays,
          timestampCoverage: {
            stamped: result.stamped,
            unstamped: result.unstamped,
            undated: result.undated,
          },
          lagDistribution: result.lagDistribution,
          writtenAfterPeriodEnd: result.writtenAfterPeriodEnd,
          postDated: result.postDated,
          candidates: result.candidates,
        },
        rows: result.candidates.length,
        warnings,
      };
    }

    case 'related_party': {
      const supplied = new Set(options.relatedParties.map((name) => name.toLowerCase()));
      const flagged = new Set(options.flaggedInTally.map((name) => name.toLowerCase()));

      const candidates = vouchers
        .filter((voucher) => {
          const party = (voucher.partyLedgerName ?? '').toLowerCase();
          if (party === '') return false;
          if (supplied.has(party) || flagged.has(party)) return true;
          // Also catch a related party appearing as an ENTRY ledger rather than
          // as the party on the voucher — a journal between two related
          // entities may name neither of them as "the party".
          return voucher.entries.some((entry) => {
            const ledger = entry.ledgerName.toLowerCase();
            return supplied.has(ledger) || flagged.has(ledger);
          });
        })
        .map((voucher) => {
          const party = (voucher.partyLedgerName ?? '').toLowerCase();
          const reasons: string[] = [];
          if (flagged.has(party)) {
            reasons.push('Party is marked IsRelatedParty in TallyPrime.');
          }
          if (supplied.has(party)) {
            reasons.push('Party is on the related-party list you supplied.');
          }
          const viaEntry = voucher.entries
            .map((entry) => entry.ledgerName)
            .filter((ledger) => {
              const key = ledger.toLowerCase();
              return (supplied.has(key) || flagged.has(key)) && key !== party;
            });
          for (const ledger of viaEntry) {
            reasons.push(`Entry against related party "${ledger}".`);
          }
          if (reasons.length === 0) reasons.push('Matched a related party.');
          return asCandidate(voucher, reasons);
        });

      const warnings = [
        'A LEDGER NOT MARKED IS NOT A LEDGER THAT IS NOT RELATED. TallyPrime `IsRelatedParty` ' +
          'flag is a seed: it is only as good as whether somebody ticked it. Relatedness under ' +
          'AS 18 / Ind AS 24 is a legal determination about directors, their relatives, key ' +
          'management personnel and entities under common control, and this connector cannot ' +
          'make it. Supply `relatedParties` from the client register.',
      ];
      if (options.flaggedInTally.length === 0 && options.relatedParties.length === 0) {
        warnings.push(
          'NO RELATED PARTIES WERE IDENTIFIED AT ALL: no ledger carries the TallyPrime flag and ' +
            'no list was supplied, so this result is empty by construction and says nothing ' +
            'about the company. It is not evidence that there were no related-party ' +
            'transactions.'
        );
      }
      // The AS 18 / Ind AS 24 disclosure table, alongside the candidates. The
      // display name comes from whichever source named the party, preferring
      // Tally's spelling because that is what the ledger is called.
      const identified = new Map<string, { display: string; source: RelatedPartySource }>();
      for (const name of options.relatedParties) {
        identified.set(name.toLowerCase(), { display: name, source: 'supplied' });
      }
      for (const name of options.flaggedInTally) {
        const key = name.toLowerCase();
        identified.set(key, {
          display: name,
          source: identified.has(key) ? 'both' : 'tally_flag',
        });
      }
      const summary = summariseRelatedParties(vouchers, identified, options.ledgerBalances);

      if (summary.some((row) => row.amountsInferredFromVoucher > 0)) {
        warnings.push(
          'ON SOME VOUCHERS the related party matched but no entry line named its ledger, so the ' +
            "voucher's largest entry stood in for the amount. Those rows carry a non-zero " +
            '`amountsInferredFromVoucher` and their totals are approximate — check them before ' +
            'the figure goes into a disclosure.'
        );
      }
      if (summary.length > 1) {
        warnings.push(
          'THE PARTY TOTALS DO NOT SUM TO A COMPANY TOTAL. A voucher between two related parties ' +
            'is a real dealing with each and is counted in both rows. Amounts are also absolute ' +
            'rather than netted, so a purchase and its payment report as volume transacted, not ' +
            'as nil — which is what the disclosure asks for.'
        );
      }

      return {
        payload: {
          relatedPartiesFlaggedInTally: options.flaggedInTally,
          relatedPartiesSupplied: options.relatedParties,
          byParty: summary,
          candidates,
        },
        rows: candidates.length,
        warnings,
      };
    }

    case 'weekend': {
      const candidates = findWeekendDated(vouchers);
      return {
        payload: { weekendDays: ['Saturday', 'Sunday'], candidates },
        rows: candidates.length,
        warnings: [
          'SATURDAY AND SUNDAY WERE ASSUMED to be the non-working days. That is wrong for a ' +
            'business that trades on Saturday, and wrong in jurisdictions whose weekend falls ' +
            'elsewhere. Say which days were treated as the weekend when quoting this.',
          'This is the voucher DATE, not the date it was entered, so it is NOT an out-of-hours ' +
            'posting test. A weekend-dated voucher keyed in on Monday is unremarkable. Test ' +
            '"late_entry" reads the write timestamp, but only to the DAY it is useful for — it ' +
            'answers "written long after its date", not "written at 2am on a Sunday".',
        ],
      };
    }
  }
}
