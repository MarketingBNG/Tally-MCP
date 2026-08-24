import {
  z,
} from 'zod';

import type { McpServer } from '@modelcontextprotocol/server';

import {
  companySchema,
  dateRangeSchema,
  isoDateSchema,
  verbositySchema,
} from '../../schemas/common.js';
import {
  trimWarnings,
} from '../verbosity.js';
import {
  runTool,
  whole,
  type ToolDeps,
} from '../toolResult.js';

import {
  rowIsNil,
} from '../statementComparison.js';
import {
  TallyError,
} from '../../tally/TallyError.js';
import {
  STATEMENT_DESCRIPTION,
  statementSchema,
} from './specs.js';
import { executeStatement } from './runners.js';
import { runMultiCompany, runTrend } from './series.js';

/**
 * The `tally_get_statement` tool registration.
 *
 * Split out of reports.ts at 1,498 lines. Schema, description and dispatch only;
 * every decision it dispatches to lives in ./specs.ts, ./diagnostics.ts and
 * ./runners.ts.
 */

export function registerReportTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_get_statement',
    {
      description: STATEMENT_DESCRIPTION,
      inputSchema: z.object({
        statement: statementSchema,
        company: companySchema,
        ...dateRangeSchema,
        compareFromDate: isoDateSchema
          .optional()
          .describe(
            'Start of a second period to compare against, ISO YYYY-MM-DD. Supply with ' +
              'compareToDate to get the same statement for both periods plus the movement per ' +
              'row. Omit both for a single period.'
          ),
        compareToDate: isoDateSchema
          .optional()
          .describe(
            'End of the comparison period, ISO YYYY-MM-DD. Must be on or after compareFromDate. ' +
              'This AND toDate must both fall on the 31st of a month — see the end-date rule in ' +
              'the description. Otherwise the call is refused with TALLY_UNSUPPORTED_OPERATION: ' +
              'two periods both silently extended to the same year end would subtract to minus ' +
              'the whole earlier period rather than the movement between them, which is a wrong ' +
              'figure of entirely plausible size. Shift each end date to a 31st and it works.'
          ),
        companies: z
          .array(z.string().min(1))
          .min(2)
          .max(10)
          .optional()
          .describe(
            'Two to ten companies to run this statement across, side by side. Every one must ' +
              'already be OPEN in TallyPrime — Tally holds several at once and this reads each in ' +
              'turn. Requires explicit fromDate and toDate: the companies keep different book ' +
              'years, so a defaulted period would silently compare different months. NO ' +
              'DIFFERENCES ARE COMPUTED between companies whose currencies differ, because ' +
              'subtracting a dollar figure from a rupee one produces a number that looks like a ' +
              'movement and means nothing.'
          ),
        periods: z
          .array(z.object({ fromDate: isoDateSchema, toDate: isoDateSchema }))
          .min(2)
          .max(12)
          .optional()
          .describe(
            'Two to twelve periods to run this statement across, giving a TREND: each row tracked ' +
              'through the series with the movement between consecutive periods. Use instead of ' +
              'fromDate/toDate/compareFromDate/compareToDate, not alongside them. Periods are kept ' +
              'in the order you give them and are NOT sorted, because "Q4 against Q1" is a real ' +
              'question and reordering would relabel every movement. EVERY period end date must ' +
              'fall on the 31st of a month — see the end-date rule in this description; a period ' +
              'ending otherwise is refused rather than answered with figures that run past it.'
          ),
        verbosity: verbositySchema,
      }),
    },
    async (args) =>
      runTool('tally_get_statement', deps, async () => {
        const verbosity = args.verbosity ?? 'full';

        if (args.companies !== undefined) {
          if (args.periods !== undefined || args.company !== undefined) {
            throw new TallyError(
              'INVALID_PARAMETERS',
              'Give `companies` on its own, not with `company` or `periods`.',
              {
                suggestion:
                  'One statement, one period, several companies. A trend across several periods ' +
                  'AND several companies is a grid rather than a statement — run one call per ' +
                  'company if that is what you need, so each result says plainly what it covers.',
              }
            );
          }
          return runMultiCompany(deps, args.statement, args.companies, args.fromDate, args.toDate);
        }

        if (args.periods !== undefined) {
          if (
            args.fromDate !== undefined ||
            args.toDate !== undefined ||
            args.compareFromDate !== undefined ||
            args.compareToDate !== undefined
          ) {
            throw new TallyError(
              'INVALID_PARAMETERS',
              'Give either `periods` or the fromDate/toDate/compare* parameters, not both.',
              {
                suggestion:
                  'A trend already carries every period it covers, so a separate period would ' +
                  'either duplicate one of them or add a period the trend does not describe. ' +
                  'Drop whichever you did not mean.',
              }
            );
          }
          return runTrend(deps, args.statement, args.periods, args.company);
        }

        const executed = await executeStatement(deps, args.statement, args);

        if (executed.comparison === null) {
          // At "summary", rows where every figure is nil are left out. They are
          // the chart of accounts showing through rather than facts about the
          // period, and on a full chart they are usually most of the rows. The
          // count is reported so the omission is visible, and the totals above
          // were computed over the WHOLE set before anything was dropped.
          const summarising = verbosity === 'summary';
          const visibleRows = summarising
            ? executed.rows.filter((row) => !rowIsNil(executed.figuresOf(row)))
            : executed.rows;
          const nilRowsOmitted = executed.rows.length - visibleRows.length;
          const trimmed = trimWarnings(verbosity, executed.warnings);

          // A statement is returned whole — it is not paginated and this server
          // applies no cap of its own, so every row Tally rendered is here.
          return whole(
            {
              statement: args.statement,
              period: executed.period,
              coversPeriodRequested: executed.coversPeriodRequested,
              ...(executed.figuresActuallyCover === null
                ? {}
                : { figuresActuallyCover: executed.figuresActuallyCover }),
              ...(args.company === undefined ? {} : { company: args.company }),
              rows: visibleRows,
              ...(summarising
                ? {
                    verbosity,
                    rowsReturned: visibleRows.length,
                    rowsInStatement: executed.rows.length,
                    nilRowsOmitted,
                    ...(nilRowsOmitted === 0
                      ? {}
                      : {
                          nilRowsNote:
                            `${String(nilRowsOmitted)} row(s) whose every figure was nil or zero ` +
                            'were omitted. No row carrying a figure was omitted, and no row with ' +
                            'an unreadable amount was treated as zero. Call again with verbosity ' +
                            '"full" for the complete statement.',
                        }),
                    ...(trimmed.note === undefined ? {} : { verbosityNote: trimmed.note }),
                  }
                : {}),
              ...(trimmed.warnings.length > 0 ? { warnings: trimmed.warnings } : {}),
            },
            visibleRows.length
          );
        }

        return whole(
          {
            statement: args.statement,
            period: executed.period,
            coversPeriodRequested: executed.coversPeriodRequested,
            ...(args.company === undefined ? {} : { company: args.company }),
            rows: executed.rows,
            comparison: {
              period: executed.comparison.period,
              rows: executed.comparison.rows,
              changes: executed.comparison.changes,
              unpaired: executed.comparison.unpaired,
            },
            ...(executed.warnings.length > 0 ? { warnings: executed.warnings } : {}),
          },
          // Both periods' rows are accounting data the caller received.
          executed.rows.length + executed.comparison.rows.length
        );
      })
  );
}
