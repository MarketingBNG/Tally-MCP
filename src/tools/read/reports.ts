/**
 * `tally_get_statement`: trial balance, balance sheet, profit and loss, cash
 * flow, fund flow.
 *
 * This is now a thin re-export. The tool grew to 1,498 lines covering four
 * separable concerns, split into ./reports/ as pure moves:
 *
 *   - specs.ts       what each statement IS — builder, normaliser, notes
 *   - diagnostics.ts the warnings a statement carries (stale stock, cost
 *                    recoveries in revenue, masters divergence)
 *   - runners.ts     running one, a trend across periods, or several companies
 *   - register.ts    the tool registration and dispatch
 *
 * All five statements share a shape — a period, a company, and a flat list of
 * rows — so they share one tool behind a `statement` discriminator. What differs
 * is only the request builder, the normaliser and the descriptive text, because
 * Tally's reports use different tag vocabularies (and, for the two flow reports,
 * a genuinely different kind of content — see flowReports.ts) for related ideas.
 */

export { registerReportTools } from './reports/register.js';
export { statementSchema } from './reports/specs.js';
export { executeStatement, type ExecutedStatement } from './reports/runners.js';
