import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { companySchema, dateRangeSchema, READ_ONLY_NOTICE } from '../schemas/common.js';
import { runTool, whole, type ToolDeps } from './toolResult.js';
import {
  executeVoucherTest,
  TEST_VALUES,
  type ProcedureOptions,
  type TestName,
} from './testVouchers.js';
import { SERVER_VERSION } from '../version.js';

/**
 * `tally_make_workpaper`: run a procedure and render it as an audit workpaper.
 *
 * ## Why this is a tool and not a formatting instruction
 *
 * The obvious way to produce a workpaper is to let the model write one from
 * whatever the conversation already contains. That produces a document which
 * LOOKS like evidence and is a transcription — figures retyped from a summary,
 * possibly from a truncated one, with no guarantee they were ever in the books.
 * A wrong number in chat is a wrong answer; the same number under a heading
 * that says "Procedure performed" and "Population tested" is a fabricated
 * working paper, and it may be the thing a peer reviewer or an inspection picks
 * up two years later.
 *
 * So this tool re-runs the procedure against TallyPrime and renders THAT. Every
 * figure in the document came out of the books during this call. It shares the
 * exact code path with `tally_test_vouchers` — see `executeVoucherTest` — so
 * the two can never disagree about what a period or a population means.
 *
 * ## What it will not do
 *
 * Write the conclusion. The conclusion is the auditor's judgement and is the
 * one part of a workpaper that must not come from a machine. If none is
 * supplied the document says so, in the place where the conclusion should be,
 * so that an unsigned paper is visibly unsigned rather than quietly complete.
 *
 * It also never softens or drops the warnings the procedure produced. Those
 * limitations — the population that could not be reached, the assumption about
 * weekends, the direction a sample is sensitive in — are the difference between
 * a defensible paper and a misleading one, and they are reproduced in full.
 */

const NOT_A_CONCLUSION =
  '_NOT RECORDED._ The conclusion is the auditor\'s judgement and is deliberately not generated. ' +
  'Record what the evidence supports, sign, and date.';

const DESCRIPTION = [
  'Run one audit procedure and render it as a workpaper: a Markdown document carrying the ' +
    'objective, the population, the method and its parameters, the results, the limitations, and ' +
    'the exact call that reproduces it.',
  '',
  'WHEN TO USE: when the output has to go into an audit file rather than just answer a question ' +
    'in conversation. Use `tally_test_vouchers` to explore; use this once you know which ' +
    'procedure you are documenting.',
  '',
  'IT RE-RUNS THE PROCEDURE. It does not accept figures and format them — it queries TallyPrime ' +
    'again and renders what came back, so every number in the document is from the books rather ' +
    'than from this conversation. Do NOT paste results into it; pass the same parameters you ' +
    'would pass to tally_test_vouchers and let it fetch. If the figures differ from an earlier ' +
    'run, the books changed, and that is worth knowing.',
  '',
  'IT DOES NOT WRITE THE CONCLUSION. Supply `conclusion` if you have reached one. If you do not, ' +
    'the document says the conclusion was not recorded, rather than inventing one — an unsigned ' +
    'workpaper should look unsigned. Never fill this parameter with your own inference from the ' +
    'results; it is the auditor\'s to write.',
  '',
  'RETURNS: `markdown`, the rendered document, plus the structured result it was rendered from ' +
    'so nothing is lost. Save the markdown to the audit file.',
  '',
  READ_ONLY_NOTICE,
].join('\n');

export function registerWorkpaperTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_make_workpaper',
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        test: z
          .enum(TEST_VALUES)
          .describe('Which procedure to run and document. Same values as tally_test_vouchers.'),
        objective: z
          .string()
          .min(1)
          .describe(
            'What this procedure was performed to establish, in your words. Required — a ' +
              'workpaper without a stated objective cannot be reviewed, because there is no ' +
              'way to judge whether the work done was the work needed.'
          ),
        conclusion: z
          .string()
          .min(1)
          .optional()
          .describe(
            'What you concluded from the results. Optional, and NEVER to be filled in on the ' +
              "auditor's behalf: omitted renders as \"not recorded\", which is the honest state " +
              'of a paper nobody has signed off.'
          ),
        preparedBy: z
          .string()
          .min(1)
          .optional()
          .describe('Who performed the procedure. Renders as "not recorded" when omitted.'),
        reference: z
          .string()
          .min(1)
          .optional()
          .describe('Your working paper reference, e.g. "C-140". Rendered in the header.'),
        company: companySchema,
        ...dateRangeSchema,
        voucherType: z.string().min(1).optional().describe('Restrict the population to this type.'),
        ledger: z.string().min(1).optional().describe('Restrict to vouchers against this ledger.'),
        party: z.string().min(1).optional().describe('Restrict to vouchers with this party.'),
        query: z.string().min(1).optional().describe('Restrict to vouchers matching this text.'),
        minAmount: z.number().optional().describe('Restrict to vouchers at least this large.'),
        maxAmount: z.number().optional().describe('Restrict to vouchers at most this large.'),
        threshold: z
          .string()
          .regex(/^\d+(\.\d+)?$/, 'Give the threshold as a plain positive number.')
          .optional()
          .describe('journal_screen only: normally your materiality figure.'),
        roundMultipleOf: z.number().positive().optional().describe('What counts as round.'),
        cutoffDays: z.number().int().positive().optional().describe('cutoff only.'),
        sampleSize: z.number().int().positive().optional().describe('sample only.'),
        sampleSeed: z.string().min(1).optional().describe('sample only: pass to reproduce.'),
        sampleMethod: z.enum(['random', 'systematic', 'monetary_unit']).optional(),
        benfordDigits: z.union([z.literal(1), z.literal(2)]).optional(),
        relatedParties: z.array(z.string().min(1)).optional(),
      }),
    },
    async (args) =>
      runTool('tally_make_workpaper', deps, async () => {
        const executed = await executeVoucherTest(deps, args);

        const markdown = renderWorkpaper({
          test: executed.test,
          objective: args.objective,
          ...(args.conclusion === undefined ? {} : { conclusion: args.conclusion }),
          ...(args.preparedBy === undefined ? {} : { preparedBy: args.preparedBy }),
          ...(args.reference === undefined ? {} : { reference: args.reference }),
          ...(args.company === undefined ? {} : { company: args.company }),
          period: executed.period,
          population: executed.population,
          options: executed.resolvedOptions,
          payload: executed.payload,
          warnings: executed.warnings,
          rows: executed.rows,
          preparedAt: new Date().toISOString(),
          serverVersion: SERVER_VERSION,
        });

        return whole(
          {
            markdown,
            test: executed.test,
            period: executed.period,
            population: executed.population,
            ...executed.payload,
            warnings: executed.warnings,
          },
          executed.rows
        );
      })
  );
}

interface WorkpaperInput {
  test: TestName;
  objective: string;
  conclusion?: string;
  preparedBy?: string;
  reference?: string;
  company?: string;
  period: { fromDate: string; toDate: string };
  population: { tested: number; excluded: Record<string, number> };
  options: ProcedureOptions;
  payload: object;
  warnings: string[];
  rows: number;
  preparedAt: string;
  serverVersion: string;
}

/** Plain-English name for each procedure, for the document heading. */
const PROCEDURE_TITLES: Record<TestName, string> = {
  journal_screen: 'Manual journal screening',
  benford: 'Benford digit-distribution analysis',
  sample: 'Sample selection',
  duplicates: 'Duplicate posting screen',
  round_numbers: 'Round-amount screen',
  cutoff: 'Cut-off proximity screen',
  weekend: 'Weekend-dated posting screen',
  related_party: 'Related-party transactions',
};

/**
 * The parameters that belong in the METHOD section, per procedure.
 *
 * Deliberately per-test rather than dumping every option: a workpaper that
 * lists `cutoffDays` on a Benford analysis invites the reviewer to think the
 * parameter did something, and a reviewer who cannot trust the method section
 * has to re-perform the whole procedure.
 */
const RELEVANT_OPTIONS: Record<TestName, string[]> = {
  journal_screen: ['threshold', 'roundMultipleOf'],
  benford: ['benfordDigits'],
  sample: ['sampleSize', 'sampleSeed', 'sampleMethod'],
  duplicates: [],
  round_numbers: ['roundMultipleOf'],
  cutoff: ['cutoffDays'],
  weekend: [],
  related_party: ['relatedParties'],
};

function orNotRecorded(value: string | undefined): string {
  return value === undefined || value.trim() === '' ? '_not recorded_' : value;
}

export function renderWorkpaper(input: WorkpaperInput): string {
  const title = PROCEDURE_TITLES[input.test];
  const lines: string[] = [];

  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  lines.push(`| Entity | ${orNotRecorded(input.company)} |`);
  lines.push(`| Period | ${input.period.fromDate} to ${input.period.toDate} |`);
  lines.push(`| Procedure | ${title} (\`${input.test}\`) |`);
  lines.push(`| Working paper ref | ${orNotRecorded(input.reference)} |`);
  lines.push(`| Prepared by | ${orNotRecorded(input.preparedBy)} |`);
  lines.push(`| Prepared at | ${input.preparedAt} |`);
  lines.push(`| Source | TallyPrime, read-only, via tally-mcp ${input.serverVersion} |`);
  lines.push('');

  lines.push('## Objective');
  lines.push('');
  lines.push(input.objective);
  lines.push('');

  lines.push('## Population');
  lines.push('');
  lines.push(`Vouchers tested: **${String(input.population.tested)}**`);
  lines.push('');
  const excluded = Object.entries(input.population.excluded).filter(([, count]) => count > 0);
  if (excluded.length === 0) {
    lines.push('Nothing was excluded from the period.');
  } else {
    lines.push('Excluded from the period, and why:');
    lines.push('');
    for (const [reason, count] of excluded) {
      lines.push(`- ${reason}: ${String(count)}`);
    }
  }
  lines.push('');

  lines.push('## Method');
  lines.push('');
  const relevant = RELEVANT_OPTIONS[input.test];
  if (relevant.length === 0) {
    lines.push('This procedure takes no parameters beyond the population above.');
  } else {
    lines.push('Parameters as applied, with defaults resolved:');
    lines.push('');
    for (const key of relevant) {
      const value = optionValue(input.options, key);
      const shown =
        Array.isArray(value) && value.length === 0
          ? '_none supplied_'
          : value === undefined
            ? '_not applied_'
            : `\`${JSON.stringify(value)}\``;
      lines.push(`- ${key}: ${shown}`);
    }
  }
  lines.push('');

  lines.push('## Results');
  lines.push('');
  lines.push(`Items returned: **${String(input.rows)}**`);
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(input.payload, null, 2));
  lines.push('```');
  lines.push('');

  // Reproduced in full and never summarised. These are the limitations that
  // make the paper defensible; a reader who does not see them will read the
  // results as saying more than they do.
  lines.push('## Limitations and notes');
  lines.push('');
  if (input.warnings.length === 0) {
    lines.push('The procedure reported no limitations.');
  } else {
    for (const warning of input.warnings) {
      lines.push(`- ${warning}`);
    }
  }
  lines.push('');

  lines.push('## Conclusion');
  lines.push('');
  lines.push(orConclusion(input.conclusion));
  lines.push('');

  lines.push('## Reproducing this paper');
  lines.push('');
  lines.push(
    'Re-run `tally_make_workpaper` with the parameters below. The figures come from TallyPrime ' +
      'at the time of the run, so a later run against changed books will differ — which is ' +
      'itself evidence, not an error.'
  );
  lines.push('');
  lines.push('```json');
  lines.push(
    JSON.stringify(
      {
        test: input.test,
        ...(input.company === undefined ? {} : { company: input.company }),
        fromDate: input.period.fromDate,
        toDate: input.period.toDate,
        ...Object.fromEntries(
          relevant
            .map((key) => [key, optionValue(input.options, key)])
            .filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0))
        ),
      },
      null,
      2
    )
  );
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

/** Read one named option without widening ProcedureOptions into an index type. */
function optionValue(options: ProcedureOptions, key: string): unknown {
  return (options as unknown as Record<string, unknown>)[key];
}

function orConclusion(conclusion: string | undefined): string {
  return conclusion === undefined || conclusion.trim() === '' ? NOT_A_CONCLUSION : conclusion;
}
