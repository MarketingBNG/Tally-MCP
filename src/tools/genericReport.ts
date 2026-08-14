import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildReportRequest } from '../tally/requests.js';
import { normalizeGenericReport } from '../tally/normalize.js';
import {
  companySchema,
  dateRangeSchema,
  paginationSchema,
  PERIOD_NOTE,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import { paginate, resolvePagination } from '../utils/pagination.js';
import { isoToTallyDate } from '../utils/dates.js';
import {
  assertCompanyIsLoaded,
  fromPage,
  resolvePeriodForCompany,
  runTool,
  type ToolDeps,
} from './toolResult.js';

/**
 * `tally_get_report`: TallyPrime's own built-in report views, behind a closed allowlist.
 *
 * ## Why an allowlist, and why it is not negotiable
 *
 * This tool was parked for a long time for a good reason. A caller-supplied
 * report ID is a caller-supplied request, and this project has since measured
 * what a request TallyPrime does not recognise actually does. Two classes:
 *
 * - An unknown **report ID** (`TYPE=Data` with an `<ID>`) returns `<LINEERROR>`
 *   harmlessly. Re-confirmed across 25 candidates with controls at both ends.
 * - An unknown **collection TYPE** raises a MODAL DIALOG on the TallyPrime
 *   desktop reading "incorrect object type". While it is open, Tally accepts
 *   connections and serves nothing until a human clicks OK. That cost two
 *   restarts to establish.
 *
 * So report IDs are the survivable class — which is what makes this tool
 * possible at all. The allowlist is still closed, for a different reason: every
 * ID below was **verified against a live TallyPrime**, and one that has not been
 * verified would be a figure of unknown provenance in a workpaper. Open the enum
 * and the tool starts answering questions with data nobody has ever checked the
 * shape of.
 *
 * ## Why the rows are not renamed
 *
 * `normalizeGenericReport` returns each row's amounts under TallyPrime's own tag
 * names. Mapping `DSPCLDRAMTA` to "debit" on a report whose columns have not
 * been verified would be asserting a meaning, and a wrong column label produces
 * a figure that is right in value and wrong in meaning — the hardest kind of
 * error to notice downstream. Where a report's shape IS fully verified there is
 * a dedicated tool for it: `tally_get_statement` for the trial balance, balance
 * sheet, P&L and the flow reports.
 */

/** One allowlisted report, with the honest status of its verification. */
interface ReportSpec {
  readonly id: string;
  readonly what: string;
  /**
   * What was actually measured on 14 Aug 2026 against a live TallyPrime
   * (an Indian company, 330 ledgers, no inventory, no bill-wise tracking).
   *
   * `content` — returned real rows; the shape below was read from them.
   * `empty` — TallyPrime ACCEPTED the ID and returned its 23-byte empty
   *   envelope. That is "valid report, nothing to show", not a rejection — but
   *   it means the row shape has never been seen, so it is unverified.
   */
  readonly verified: 'content' | 'empty';
  /** Whether the report is scoped by a period at all. */
  readonly periodApplies: boolean;
}

const REPORTS = {
  negative_ledgers: {
    id: 'Negative Ledgers',
    what:
      'Ledgers carrying a balance on the side they should not. An audit-grade exception ' +
      'report: negative cash is impossible in reality, so it is one of the classic ' +
      'first things to look at.',
    verified: 'content',
    periodApplies: true,
  },
  negative_stock: {
    id: 'Negative Stock',
    what: 'Stock items showing a negative quantity — goods issued that were never received.',
    verified: 'empty',
    periodApplies: true,
  },
  ratio_analysis: {
    id: 'Ratio Analysis',
    what: "TallyPrime's own ratio summary.",
    verified: 'content',
    periodApplies: true,
  },
  sales_register: {
    id: 'Sales Register',
    what: 'Sales summarised the way TallyPrime presents it.',
    verified: 'content',
    periodApplies: true,
  },
  purchase_register: {
    id: 'Purchase Register',
    what: 'Purchases summarised the way TallyPrime presents it.',
    verified: 'content',
    periodApplies: true,
  },
  journal_register: {
    id: 'Journal Register',
    what:
      'Journals summarised the way TallyPrime presents it. The journal population is the ' +
      'highest-risk one in a ledger; tally_test_vouchers with test "journal_screen" is the ' +
      'tool that examines it entry by entry.',
    verified: 'content',
    periodApplies: true,
  },
  bills_receivable: {
    id: 'Bills Receivable',
    what: "Outstanding receivable bills as TallyPrime's own report presents them.",
    verified: 'empty',
    periodApplies: true,
  },
  bills_payable: {
    id: 'Bills Payable',
    what: "Outstanding payable bills as TallyPrime's own report presents them.",
    verified: 'empty',
    periodApplies: true,
  },
  cost_category_summary: {
    id: 'Cost Category Summary',
    what: 'Cost categories and their totals.',
    verified: 'empty',
    periodApplies: true,
  },
} as const satisfies Record<string, ReportSpec>;

type ReportKey = keyof typeof REPORTS;

const REPORT_KEYS = Object.keys(REPORTS) as [ReportKey, ...ReportKey[]];

/** Reports whose row shape has never been observed, listed for the description. */
const UNVERIFIED_KEYS = REPORT_KEYS.filter((key) => REPORTS[key].verified === 'empty');

const DESCRIPTION = [
  "TallyPrime's own built-in report views, from a closed list of IDs verified against a live " +
    'install. Use this for the exception and register views that have no dedicated tool.',
  '',
  'REPORTS (`report`):',
  ...REPORT_KEYS.map(
    (key) =>
      `- ${key} ("${REPORTS[key].id}"): ${REPORTS[key].what}` +
      (REPORTS[key].verified === 'empty' ? ' ROW SHAPE UNVERIFIED — see below.' : '')
  ),
  '',
  'COLUMNS ARE NOT RENAMED. Each row comes back as a name plus an `amounts` map keyed by ' +
    "TallyPrime's own tag names — DSPCLDRAMTA, DSPCLCRAMTA and whatever else the particular " +
    'report emits. They are deliberately not mapped to "debit" and "credit": that mapping has ' +
    'only been verified for the reports that have their own tool, and asserting it here would ' +
    'produce figures that are right in value and wrong in meaning. Say which tag a number came ' +
    'from when quoting it.',
  '',
  `ROW SHAPE UNVERIFIED for: ${UNVERIFIED_KEYS.join(', ')}. TallyPrime ACCEPTED each of these ` +
    'IDs — they are valid — but on the company they were tested against each returned an empty ' +
    'result, because that company keeps no inventory, uses no bill-wise tracking and defines no ' +
    'cost categories. So their rows have never actually been seen. They are offered because the ' +
    'ID is proven valid; treat the first result from one as something to sanity-check against ' +
    'TallyPrime on screen, not as established.',
  '',
  'AN EMPTY RESULT IS A REAL ANSWER on an exception report — "no negative ledgers" is the ' +
    'outcome you want. But it looks identical to a feature the company does not use, so check ' +
    'which one you are looking at before reporting it as a clean result.',
  '',
  'WHY THE LIST IS CLOSED: an unrecognised report ID is refused harmlessly by TallyPrime, so ' +
    'this is not a safety limit — it is a provenance one. Every ID here was verified live. An ' +
    'arbitrary ID would put a figure of unknown derivation into an answer, which is the one ' +
    'thing this connector will not do. If you need a view that is not listed, it has to be ' +
    'probed and added deliberately.',
  '',
  'FOR THE MAIN STATEMENTS use tally_get_statement instead — the trial balance, balance sheet, ' +
    'P&L, cash flow and funds flow have verified column meanings there, and this tool would ' +
    'give you the same numbers with less said about them.',
  '',
  PERIOD_NOTE,
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

export function registerGenericReportTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_get_report',
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        report: z
          .enum(REPORT_KEYS)
          .describe(
            'Which built-in report to read. The list is closed and every ID in it was verified ' +
              'against a live TallyPrime.'
          ),
        ...dateRangeSchema,
        company: companySchema,
        ...paginationSchema,
      }),
    },
    async (args) =>
      runTool('tally_get_report', deps, async () => {
        const key: ReportKey = args.report;
        const spec = REPORTS[key];

        // Tally's own spelling, never the caller's. An unmatched SVCURRENTCOMPANY
        // returns an EMPTY report (measured 14 Aug 2026), which reads as "nothing to
        // report" on an exception report — so the name is checked against the loaded
        // list before the request rather than after.
        const company = await assertCompanyIsLoaded(deps, args.company);
        const period = await resolvePeriodForCompany(deps, args.fromDate, args.toDate, args.company);

        const response = await deps.client.send(
          buildReportRequest(spec.id, {
            ...(company === undefined ? {} : { company }),
            fromDate: isoToTallyDate(period.fromDate),
            toDate: isoToTallyDate(period.toDate),
          }),
          'report'
        );

        const { data, warnings } = normalizeGenericReport(response.body, spec.id);

        const allWarnings = [...response.repairs, ...warnings];
        if (spec.verified === 'empty') {
          allWarnings.unshift(
            `ROW SHAPE UNVERIFIED: TallyPrime accepts "${spec.id}", but on the company this ` +
              'server was tested against it returned no rows, so its row layout has never been ' +
              'observed. Check these figures against the report on screen in TallyPrime before ' +
              'relying on them.'
          );
        }
        allWarnings.push(
          `The "amounts" keys are TallyPrime's own tag names, not renamed columns. This report's ` +
            'column meanings have not been verified, so say which tag a figure came from rather ' +
            'than calling it a debit or a credit.'
        );

        const pagination = resolvePagination(args.page, args.pageSize);
        return fromPage(paginate(data, pagination, allWarnings), {
          report: key,
          reportId: spec.id,
          period,
        });
      })
  );
}
