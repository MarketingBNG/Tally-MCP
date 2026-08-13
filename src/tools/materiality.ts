import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { READ_ONLY_NOTICE } from '../schemas/common.js';
import { DEFAULT_CURRENCY } from '../utils/numbers.js';
import { TallyError } from '../tally/TallyError.js';
import { runTool, whole, type ToolDeps } from './toolResult.js';

/**
 * Materiality thresholds.
 *
 * Build Specification v1.0 §4 L5 lists `materiality_calculate` as P1:
 * "Overall / performance / clearly-trivial thresholds with documented basis."
 * §6 rule 1 is what shapes it — the model must never compute a figure that
 * reaches a workpaper, so the arithmetic is here, in Decimal, and the model's
 * job is to explain the answer rather than produce it.
 *
 * ## Why the benchmark is an input rather than something this reads from Tally
 *
 * Materiality starts from a benchmark: revenue, total assets, or profit before
 * tax. Extracting "revenue" from a TallyPrime profit-and-loss export means
 * matching on row names, and row names are whatever the company called them.
 * A tool that guesses which row is revenue and is wrong does not fail — it
 * produces a plausible threshold on the wrong base, and every sampling and
 * scoping decision downstream inherits the error silently.
 *
 * So the benchmark amount is supplied by the caller, who has read the
 * statements and chosen it. That is where the judgement belongs: choosing the
 * benchmark is an auditor's decision (§10 — "every mapping table, every test
 * threshold ... is professional judgement. IT cannot source those"), while the
 * percentages and the arithmetic are mechanical. This tool does the mechanical
 * half exactly and refuses to do the other half at all.
 */

/**
 * Customary percentage ranges, and the default this tool applies.
 *
 * These are the ranges in common professional use rather than anything
 * prescribed by a standard — no auditing standard fixes a percentage, because
 * materiality is a judgement about the users of the financial statements. They
 * are offered as a documented starting point, and every one of them can be
 * overridden.
 */
const BENCHMARKS = {
  profit_before_tax: {
    defaultPercent: '5',
    range: '5–10%',
    note: 'Common for profit-oriented entities where earnings are what users focus on. Unstable when profit is close to nil — a small swing moves the threshold enormously, which is the usual reason to choose a different benchmark.',
  },
  revenue: {
    defaultPercent: '1',
    range: '0.5–1%',
    note: 'Common where profit is volatile, marginal or loss-making, and for entities judged on scale of operations.',
  },
  total_assets: {
    defaultPercent: '1',
    range: '1–2%',
    note: 'Common for asset-intensive entities, investment vehicles and holding companies.',
  },
  total_expenditure: {
    defaultPercent: '1',
    range: '0.5–1%',
    note: 'Common for not-for-profits and entities where spending rather than earning is the focus.',
  },
  equity: {
    defaultPercent: '2',
    range: '1–5%',
    note: 'Occasionally used where net worth is the primary user concern.',
  },
} as const;

type BenchmarkName = keyof typeof BENCHMARKS;

const DESCRIPTION = [
  'Compute overall materiality, performance materiality and the clearly-trivial threshold ' +
    'from a benchmark figure, with the basis documented alongside.',
  '',
  'WHEN TO USE: when planning an audit or review, and whenever a question depends on whether ' +
    'an amount is material. Use the returned figures rather than working thresholds out in ' +
    'conversation — the arithmetic here is exact and it is recorded with its basis, which is ' +
    'what a workpaper needs.',
  '',
  'YOU MUST SUPPLY THE BENCHMARK AMOUNT. This tool does not read it from TallyPrime, on ' +
    'purpose: deciding which figure is "revenue" or "profit before tax" in a particular set of ' +
    'books is a judgement, and a tool that guessed wrong would produce a credible threshold on ' +
    'the wrong base. Read the figure from tally_get_statement, agree it with the user, then pass ' +
    'it here.',
  '',
  'RETURNS: overall materiality, performance materiality, the clearly-trivial threshold, and ' +
    'the full basis — benchmark used, amount, percentages applied, and the customary range for ' +
    'that benchmark so the choice can be seen to be reasonable or deliberately not.',
  '',
  'PERCENTAGES: sensible defaults are applied and stated (see the basis in the response), and ' +
    'every one can be overridden. No auditing standard fixes a percentage — materiality is a ' +
    'judgement about the users of the financial statements — so treat the defaults as a ' +
    'documented starting point to discuss, never as the answer.',
  '',
  'PAGINATION: not applicable.',
  '',
  READ_ONLY_NOTICE,
].join('\n');

export interface MaterialityResult {
  overall: string;
  performance: string;
  clearlyTrivial: string;
  currency: string;
  basis: {
    benchmark: BenchmarkName;
    benchmarkAmount: string;
    overallPercent: string;
    performancePercentOfOverall: string;
    clearlyTrivialPercentOfOverall: string;
    customaryRange: string;
    note: string;
    /** The arithmetic, spelled out, so the figures can be re-derived by hand. */
    workings: string[];
  };
}

/**
 * The computation, separated from the tool so it is directly testable.
 *
 * Rounding is deliberately DOWN, to the rupee. A threshold rounded up is a
 * threshold that excuses slightly more error than the basis justifies, and
 * erring towards catching more is the right direction for a control.
 */
export function computeMateriality(input: {
  benchmark: BenchmarkName;
  amount: string;
  currency: string;
  overallPercent: string;
  performancePercent: string;
  clearlyTrivialPercent: string;
}): MaterialityResult {
  const base = new Decimal(input.amount).abs();

  const overall = base.times(input.overallPercent).dividedBy(100).floor();
  const performance = overall.times(input.performancePercent).dividedBy(100).floor();
  const clearlyTrivial = overall.times(input.clearlyTrivialPercent).dividedBy(100).floor();

  const spec = BENCHMARKS[input.benchmark];

  return {
    overall: overall.toFixed(),
    performance: performance.toFixed(),
    clearlyTrivial: clearlyTrivial.toFixed(),
    currency: input.currency,
    basis: {
      benchmark: input.benchmark,
      benchmarkAmount: base.toFixed(),
      overallPercent: input.overallPercent,
      performancePercentOfOverall: input.performancePercent,
      clearlyTrivialPercentOfOverall: input.clearlyTrivialPercent,
      customaryRange: spec.range,
      note: spec.note,
      workings: [
        `Overall materiality = ${input.overallPercent}% of ${input.benchmark} ${base.toFixed()} = ${overall.toFixed()}`,
        `Performance materiality = ${input.performancePercent}% of overall materiality = ${performance.toFixed()}`,
        `Clearly trivial = ${input.clearlyTrivialPercent}% of overall materiality = ${clearlyTrivial.toFixed()}`,
        'All three rounded DOWN to the whole unit, so a threshold never excuses more error than its basis supports.',
      ],
    },
  };
}

export function registerMaterialityTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_calculate_materiality',
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        benchmark: z
          .enum(['profit_before_tax', 'revenue', 'total_assets', 'total_expenditure', 'equity'])
          .describe(
            'Which figure the threshold is based on. The choice is a judgement: profit-based for ' +
              'profitable trading entities, revenue or assets where profit is volatile or marginal.'
          ),
        amount: z
          .string()
          .min(1)
          .describe(
            'The benchmark amount, as a plain number string, e.g. "12500000". Read it from the ' +
              'financial statements and agree it with the user first. Sign is ignored — a loss is ' +
              'as valid a base as a profit.'
          ),
        currency: z
          .string()
          .optional()
          .describe(`Currency label for the output. Defaults to ${DEFAULT_CURRENCY}.`),
        overallPercent: z
          .string()
          .optional()
          .describe(
            'Percentage of the benchmark for overall materiality, e.g. "5". Defaults to the ' +
              'customary figure for the chosen benchmark, which is stated in the response.'
          ),
        performancePercent: z
          .string()
          .optional()
          .describe(
            'Performance materiality as a percentage OF OVERALL MATERIALITY, e.g. "75". ' +
              'Customarily 50–75%, lower where the risk of misstatement is higher. Defaults to 75.'
          ),
        clearlyTrivialPercent: z
          .string()
          .optional()
          .describe(
            'Clearly-trivial threshold as a percentage OF OVERALL MATERIALITY, e.g. "5". ' +
              'Customarily 5%. Defaults to 5.'
          ),
      }),
    },
    async (args) =>
      runTool('tally_calculate_materiality', deps, async () => {
        const percentages = {
          overallPercent: args.overallPercent ?? BENCHMARKS[args.benchmark].defaultPercent,
          performancePercent: args.performancePercent ?? '75',
          clearlyTrivialPercent: args.clearlyTrivialPercent ?? '5',
        };

        assertNumeric(args.amount, 'amount');
        for (const [name, value] of Object.entries(percentages)) {
          assertNumeric(value, name);
          assertPercentage(value, name);
        }

        const result = computeMateriality({
          benchmark: args.benchmark,
          amount: args.amount,
          currency: args.currency ?? DEFAULT_CURRENCY,
          ...percentages,
        });

        return Promise.resolve(whole(result, 1));
      })
  );
}

/** Refuse a benchmark that is not a number, rather than reading it as NaN. */
function assertNumeric(value: string, field: string): void {
  let parsed: Decimal;
  try {
    parsed = new Decimal(value);
  } catch {
    throw new TallyError(
      'INVALID_PARAMETERS',
      `"${field}" must be a plain number; received "${value}".`,
      {
        suggestion: 'Pass digits only, e.g. "12500000". No commas, currency symbols or units.',
      }
    );
  }
  if (!parsed.isFinite()) {
    throw new TallyError(
      'INVALID_PARAMETERS',
      `"${field}" must be a finite number; received "${value}".`
    );
  }
}

/**
 * A percentage outside 0–100 is almost certainly a mistake, and a materiality
 * threshold is the wrong place to let one through quietly.
 */
function assertPercentage(value: string, field: string): void {
  const parsed = new Decimal(value);
  if (parsed.lessThanOrEqualTo(0) || parsed.greaterThan(100)) {
    throw new TallyError(
      'INVALID_PARAMETERS',
      `"${field}" must be a percentage above 0 and at most 100; received "${value}".`,
      {
        suggestion:
          'Pass the percentage itself, not a fraction — "5" for five percent, not "0.05".',
      }
    );
  }
}
