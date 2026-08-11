import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { TallyError } from '../tally/TallyError.js';
import { companySchema, dateRangeSchema, READ_ONLY_NOTICE } from '../schemas/common.js';
import { runTool, type ToolDeps } from './toolResult.js';

/**
 * Cash flow and fund flow.
 *
 * These are registered and always fail with `TALLY_UNSUPPORTED_OPERATION`,
 * following the project's fallback policy: a tool with no reliable retrieval
 * path is registered and explains itself, rather than being silently omitted
 * so that Claude keeps guessing at a tool that does not exist.
 *
 * ## Why not implemented
 *
 * Two independent reasons, either of which would be sufficient.
 *
 * **The retrieval path is unverified and probing it is dangerous.** Tally's
 * cash flow and fund flow reports have export IDs this project has not
 * confirmed. An unresolvable report ID does not return an error — it raises a
 * modal dialog, freezes Tally's HTTP listener, and terminates the application
 * when dismissed. Guessing at a report name to see what happens is not an
 * acceptable cost.
 *
 * **Deriving one would mean inventing the classification.** A cash flow
 * statement is not a list of bank movements; it is those movements classified
 * into operating, investing and financing activities. That classification is a
 * judgement about the business, and this server has no business rules by
 * design. Producing something labelled "cash flow" from an assumed mapping
 * would be exactly the kind of authoritative-looking invention the project
 * exists to avoid.
 *
 * What *is* available is the underlying movement data, and the error points
 * there — so the answer is a redirection rather than a dead end.
 */

interface UnsupportedSpec {
  tool: string;
  title: string;
  why: string;
  instead: string;
}

const SPECS: readonly UnsupportedSpec[] = [
  {
    tool: 'tally_get_cash_flow',
    title: 'Cash flow statement',
    why:
      'A cash flow statement requires classifying movements into operating, investing and ' +
      'financing activities. That classification is a judgement about the business, and this ' +
      'server holds no business rules — producing one from an assumed mapping would present an ' +
      'invented classification as fact. TallyPrime own cash flow report also has no retrieval ' +
      'path confirmed against a real install.',
    instead:
      'The underlying data IS available. Use tally_get_ledger_transactions on the cash and bank ' +
      'ledgers (find them with tally_search_ledgers for the "Bank Accounts" and "Cash-in-Hand" ' +
      'groups) to get every movement with dates, counterparties and a running balance. You can ' +
      'then classify them yourself and state the basis you used.',
  },
  {
    tool: 'tally_get_fund_flow',
    title: 'Fund flow statement',
    why:
      'A fund flow statement requires deciding what counts as a source and an application of ' +
      'funds, and comparing working capital between two points. Both are judgements this server ' +
      'will not make on your behalf. TallyPrime own fund flow report also has no confirmed ' +
      'retrieval path.',
    instead:
      'Use tally_get_balance_sheet for two periods and compare them, with ' +
      'tally_get_ledger_transactions for the movements behind any change worth explaining. State ' +
      'which items you treated as sources and which as applications.',
  },
];

export function registerFlowReportTools(server: McpServer, deps: ToolDeps): void {
  for (const spec of SPECS) {
    server.registerTool(
      spec.tool,
      {
        description: [
          `${spec.title} — NOT AVAILABLE. This tool always fails with ` +
            'TALLY_UNSUPPORTED_OPERATION and returns an explanation.',
          '',
          'It is registered rather than omitted so that the limitation is discoverable: calling ' +
            'it tells you why the data cannot be produced and which tools to use instead.',
          '',
          `WHY: ${spec.why}`,
          '',
          `INSTEAD: ${spec.instead}`,
          '',
          'Do not call this expecting data. Go straight to the tools named above, and tell the ' +
            'user that this statement has to be assembled rather than fetched.',
          '',
          READ_ONLY_NOTICE,
        ].join('\n'),
        // The same inputs the real report would take, so the shape is stable
        // if a verified path ever replaces this.
        inputSchema: z.object({ company: companySchema, ...dateRangeSchema }),
      },
      async () =>
        runTool(spec.tool, deps.logger, () => {
          throw new TallyError(
            'TALLY_UNSUPPORTED_OPERATION',
            `${spec.title} is not available from this server. ${spec.why}`,
            { suggestion: spec.instead }
          );
        })
    );
  }
}
