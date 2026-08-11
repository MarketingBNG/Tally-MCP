import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { McpServer as Server } from '@modelcontextprotocol/server';
import {
  buildBalanceSheetRequest,
  buildProfitLossRequest,
  buildTrialBalanceRequest,
  type TallyRequestOptions,
} from '../tally/requests.js';
import {
  normalizeBalanceSheet,
  normalizeProfitLoss,
  normalizeTrialBalance,
  type Normalized,
} from '../tally/normalize.js';
import {
  companySchema,
  dateRangeSchema,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import { assertCompanyIsLoaded, resolvePeriod, runTool, type ToolDeps } from './toolResult.js';

/**
 * Financial statement tools: trial balance, balance sheet, profit and loss.
 *
 * All three share a shape — a period, a company, and a flat list of rows — so
 * they share an implementation. What differs is only the request builder and
 * the normaliser, because Tally's three reports use three different tag
 * vocabularies for the same idea.
 *
 * These are report-class requests and use the longer timeout. They are
 * summaries by group, not per-ledger detail: Tally returns the top-level
 * groups it shows on screen.
 */

const SIGN_NOTE =
  'SIGNS — read this before quoting a figure to the user. Values are reported exactly as ' +
  'TallyPrime encodes them and are never adjusted, which means DEBIT FIGURES ARRIVE NEGATIVE. ' +
  'TallyPrime own screen shows the same figure as a POSITIVE number in a "Debit" column: a ' +
  'debit of -1161289.87 here appears in Tally as 11,61,289.87 under Debit. Verified row by row ' +
  'against a live trial balance. So when reporting a debit, give the magnitude and say it is a ' +
  'debit — quoting the minus sign as though the balance were negative will contradict what the ' +
  'user sees on screen. Expense figures in the P&L arrive negative for the same reason. ' +
  'A null figure means Tally returned an empty column, which is NOT a zero — a genuine zero is ' +
  'reported as 0.';

const PERIOD_NOTE =
  'PERIOD: if fromDate and toDate are both omitted, the Indian financial year containing today ' +
  '(1 April to 31 March) is used, matching TallyPrime own default. The period actually used is ' +
  'always echoed back in the response. Supply both dates or neither.';

const GROUP_NOTE =
  'GRANULARITY: top-level groups as TallyPrime presents them, not individual ledgers. ' +
  'For per-ledger balances use tally_list_ledgers.';

const TRIAL_BALANCE_DESCRIPTION = [
  'Fetch the trial balance: closing debit and credit totals per account group.',
  '',
  'WHEN TO USE: to check that the books balance, or as the starting point for an analysis ' +
    'that then drills into specific groups or ledgers.',
  '',
  'RETURNS: one row per group with its closing debit and credit figures.',
  '',
  GROUP_NOTE,
  '',
  SIGN_NOTE,
  '',
  PERIOD_NOTE,
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

const BALANCE_SHEET_DESCRIPTION = [
  'Fetch the balance sheet as at the end of the period.',
  '',
  'WHEN TO USE: to see the financial position — assets, liabilities and capital — at a date.',
  '',
  'RETURNS: one row per group with its main figure and, where Tally provides one, an ' +
    'indented sub-total.',
  '',
  GROUP_NOTE,
  '',
  SIGN_NOTE,
  '',
  PERIOD_NOTE,
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

const PROFIT_LOSS_DESCRIPTION = [
  'Fetch the profit and loss statement for the period.',
  '',
  'WHEN TO USE: to review income and expenditure over a period, or to compare periods by ' +
    'calling it twice with different date ranges.',
  '',
  'RETURNS: one row per group with its main figure and, where Tally provides one, an ' +
    'indented sub-total. Expenses arrive negative.',
  '',
  GROUP_NOTE,
  '',
  SIGN_NOTE,
  '',
  PERIOD_NOTE,
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

/** Register one statement tool. The three differ only in builder and normaliser. */
function registerStatementTool<T>(
  server: Server,
  deps: ToolDeps,
  spec: {
    name: string;
    description: string;
    build: (options: TallyRequestOptions) => string;
    normalize: (xml: string) => Normalized<T[]>;
  }
): void {
  server.registerTool(
    spec.name,
    {
      description: spec.description,
      inputSchema: z.object({ company: companySchema, ...dateRangeSchema }),
    },
    async (args) =>
      runTool(spec.name, deps.logger, async () => {
        const period = resolvePeriod(args.fromDate, args.toDate);
        await assertCompanyIsLoaded(deps, args.company);

        const request = spec.build({
          ...(args.company === undefined ? {} : { company: args.company }),
          fromDate: period.fromDate,
          toDate: period.toDate,
          format: deps.config.tallyPreferredFormat,
        });

        // Statements are report-class: they get the longer timeout.
        const response = await deps.client.send(request, 'report');
        const { data, warnings } = spec.normalize(response.body);

        const allWarnings = [...response.repairs, ...warnings];
        return {
          period,
          ...(args.company === undefined ? {} : { company: args.company }),
          rows: data,
          ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
        };
      })
  );
}

export function registerReportTools(server: McpServer, deps: ToolDeps): void {
  registerStatementTool(server, deps, {
    name: 'tally_get_trial_balance',
    description: TRIAL_BALANCE_DESCRIPTION,
    build: buildTrialBalanceRequest,
    normalize: normalizeTrialBalance,
  });

  registerStatementTool(server, deps, {
    name: 'tally_get_balance_sheet',
    description: BALANCE_SHEET_DESCRIPTION,
    build: buildBalanceSheetRequest,
    normalize: normalizeBalanceSheet,
  });

  registerStatementTool(server, deps, {
    name: 'tally_get_profit_loss',
    description: PROFIT_LOSS_DESCRIPTION,
    build: buildProfitLossRequest,
    normalize: normalizeProfitLoss,
  });
}
