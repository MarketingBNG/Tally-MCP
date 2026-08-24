import {
  z,
} from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  companySchema,
  dateRangeSchema,
  PERIOD_NOTE,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
  verbositySchema,
} from '../../schemas/common.js';

import {
  assertCompanyIsLoaded,
  runTool,
  whole,
  type ToolDeps,
} from '../toolResult.js';
import {
} from '../findings.js';
import {
  TallyError,
} from '../../tally/TallyError.js';


/**
 * Tie-out: does the arithmetic in these books actually hold?
 *
 * Build Specification v1.0 §1 makes this outcome 3 — "books tie" — and §4 L5
 * makes `tie_out_gate` a BLOCKING control: nothing goes to a client until it
 * passes. This tool is the first working piece of that gate, and it is the
 * cheapest one to build, because it needs no warehouse: both sides of the
 * comparison are already retrievable from TallyPrime.
 *
 * Two checks, deliberately independent of each other.
 *
 * 1. **Double entry.** Every voucher's debits must equal its credits. Needs no
 *    balances at all, so it works even where opening balances are missing, and
 *    an unbalanced voucher is a hard finding under any framework.
 *
 * 2. **Balance roll-forward.** For each ledger, opening balance plus the
 *    period's movements must equal the closing balance TallyPrime reports.
 *    This is the same arithmetic `tally_get_ledger_transactions` performs for
 *    a single ledger, applied across every ledger at once — which is what
 *    turns a spot check into a control.
 *
 * WRITTEN AGAINST THE MODEL, NOT AGAINST TALLY. Everything below operates on
 * `src/model/ledger.ts` types, reached through the adapter. That is not
 * ceremony: Annexure A §3.3 requires every audit test to be written once,
 * against the normalised model, and this is the first test to do it. When a
 * Zoho Books or QuickBooks adapter appears, this file should not need to
 * change at all. If it does, the model is wrong.
 *
 * NO LLM ARITHMETIC (§6 rule 1). Every figure here is computed in Decimal and
 * returned with the inputs that produced it, so the model reports a number it
 * was given rather than one it worked out.
 */
import {
  applyVerbosity,
  tieOutOneCompany,
  type CompanyTieOut,
} from './run.js';

/**
 * The `tally_check_tie_out` tool registration.
 *
 * Split out of tieOut.ts at 1,149 lines. Description, schema and the
 * single-versus-batch dispatch; every judgement lives in ./checks.ts.
 */

const DESCRIPTION = [
  'Check that the books tie: every voucher balances, every ledger closing balance equals its ' +
    'opening balance plus the movements in the period, and the stock figure in the accounts ' +
    'agrees with the stock records.',
  '',
  'WHEN TO USE: before relying on ANY figure from these books for a report, a workpaper or a ' +
    'client deliverable. Run it first and quote the result. If it fails, the numbers from every ' +
    'other tool are suspect and should not be presented until the exceptions are explained.',
  '',
  'RETURNS: a pass/fail verdict, then counts of what was checked, then the exceptions ' +
    'themselves — unbalanced vouchers with the amount they are out by, ledgers whose ' +
    'computed closing balance disagrees with the one TallyPrime reports, and any date at which ' +
    'stock per the general ledger disagrees with stock per the stock records, each showing both ' +
    'figures and the difference.',
  '',
  'THE STOCK TIE-OUT IS CHECKED AT BOTH ENDS of the period, and the two mean different things. ' +
    'A difference at OPENING was already wrong before the period began — an opening-balance or ' +
    'conversion error. A difference at CLOSING only means stock moved in the stock records ' +
    'without a matching entry reaching the general ledger, which makes cost of sales wrong by ' +
    'that amount. Reporting only the closing gap would merge the two into one figure and hide ' +
    'both causes. Where nothing could be tied, `checks.stockTieOut.applicable` is false and ' +
    '`notApplicableReason` says WHICH of three states it is — the company keeps no inventory, ' +
    'or it holds stock records but no stock ledger to tie them against, or a stock ledger with ' +
    'no stock records behind it. Only the first is benign: the second means inventory is ' +
    'unconstrained by double entry and an error in it would reach the accounts unchallenged. ' +
    'Report which one rather than calling any of them a pass.',
  '',
  'HOW THE COMPARISON WORKS, and its one real limitation: the closing balance TallyPrime ' +
    'reports for a ledger is as at TALLY OWN CURRENT PERIOD END, not the end of the range asked ' +
    'for here. So the roll-forward check is only meaningful when the range covers the company ' +
    'whole period. Given no dates, this tool defaults to the financial year the company books ' +
    'begin in — NOT the financial year containing today, which is what the other tools default ' +
    'to — because that is the range most likely to line up. Given explicit dates, it checks them ' +
    'and warns that a partial range will disagree for reasons that are not errors.',
  '',
  'NOT CHECKABLE is reported separately from FAILED, and the distinction matters: a ledger with ' +
    'no opening balance, or a voucher carrying an unreadable amount, cannot be verified either ' +
    'way. Counting those as passes would overstate the assurance this gives.',
  '',
  'SEVERAL COMPANIES AT ONCE: pass `companies: ["A", "B"]` instead of `company` to check each ' +
    'in one call. Every company is checked against its OWN books and its own book year; nothing ' +
    'is totalled across them. The overall `passed` is true only if all of them pass.',
  '',
  'FINDINGS: alongside the prose warnings, every result carries `findings` — typed objects with ' +
    'a severity ("exception" for books that are out, "not_checkable" for what could not be ' +
    'verified, "info"), a stable `code`, the subject, and the figures behind it. Triage on those ' +
    'rather than by reading the warning text. `findingCounts` and `highestSeverity` summarise them.',
  '',
  'VERBOSITY: pass verbosity "summary" to drop the standing explanatory notes and return only ' +
    'the findings, with a count of what was omitted. Exceptions are never suppressed.',
  '',
  PERIOD_NOTE,
  '',
  'PAGINATION: not applicable — exceptions are returned in full, because a truncated exception ' +
    'register is not a control.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

export function registerTieOutTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_check_tie_out',
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        company: companySchema,
        companies: z
          .array(z.string().min(1))
          .min(1)
          .max(10)
          .optional()
          .describe(
            'Check several companies in ONE call, each against its own books. Returns a ' +
              'per-company result plus an overall verdict that passes only if every company ' +
              'passes. Mutually exclusive with `company`. Each company is checked independently ' +
              'and no figure is ever combined across them.'
          ),
        ...dateRangeSchema,
        verbosity: verbositySchema,
      }),
    },
    async (args) =>
      runTool('tally_check_tie_out', deps, async () => {
        const verbosity = args.verbosity ?? 'full';
        const dates = { fromDate: args.fromDate, toDate: args.toDate };

        if (args.companies !== undefined) {
          if (args.company !== undefined) {
            throw new TallyError(
              'INVALID_PARAMETERS',
              'Give either `company` or `companies`, not both.',
              {
                suggestion:
                  '`companies` already covers the single-company case — drop whichever you did ' +
                  'not mean.',
              }
            );
          }

          const seen = new Set<string>();
          for (const name of args.companies) {
            const key = name.trim().toLowerCase();
            if (seen.has(key)) {
              throw new TallyError(
                'INVALID_PARAMETERS',
                `Company "${key}" is listed more than once.`,
                {
                  suggestion:
                    'Checking one company twice would report the same exceptions twice and ' +
                    'double the overall counts. Remove the repeat.',
                }
              );
            }
            seen.add(key);
          }

          // Resolved to Tally's own spelling BEFORE any work, so an unknown
          // name fails fast rather than after several slow report fetches.
          const canonical: string[] = [];
          for (const name of args.companies) {
            const resolved = await assertCompanyIsLoaded(deps, name);
            if (resolved === undefined) {
              throw new TallyError(
                'TALLY_COMPANY_NOT_LOADED',
                `Could not resolve the company "${name}".`
              );
            }
            canonical.push(resolved);
          }

          // Sequential: Tally serves one request at a time, and awaiting in
          // order keeps a failure attributable to the company that caused it.
          const results: CompanyTieOut[] = [];
          for (const company of canonical) {
            results.push(await tieOutOneCompany(deps, company, dates));
          }

          const allFindings = results.flatMap((result) => result.findings);
          const allNotes = results.flatMap((result) => result.informationalNotes);

          // Passes only if EVERY company passes. A batch that reported a
          // pass while one company was out would be worse than no gate.
          const passed = results.every((result) => result.passed);

          return whole(
            {
              passed,
              companiesChecked: canonical,
              /**
               * Per company, never combined. Totals across separate legal
               * entities are meaningless and, where currencies differ, wrong.
               */
              perCompany: results.map((result) => ({
                company: result.company,
                passed: result.passed,
                exceptions: result.exceptionCount,
                ...result.payload,
              })),
              ...applyVerbosity(verbosity, allFindings, allNotes),
            },
            results.reduce((total, result) => total + result.exceptionCount, 0)
          );
        }

        const result = await tieOutOneCompany(deps, args.company, dates);

        return whole(
          {
            ...result.payload,
            ...applyVerbosity(verbosity, result.findings, result.informationalNotes),
          },
          result.exceptionCount
        );
      })
  );
}
