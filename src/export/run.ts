/**
 * The unattended export run.
 *
 * This is now a re-export barrel. The runner grew to 736 lines, split into
 * ./run/ as pure moves:
 *
 *   - state.ts        the state file, run log, lock and status file
 *   - tables.ts       the tab order the workbook is built in, and the CSV mirror
 *   - orchestrate.ts  which companies to export, and running one at a time
 *
 * **It cannot confirm Google Drive uploaded anything.** That is Drive Desktop's
 * business. The run log and the status filename say the file was WRITTEN, never
 * that it synced. If Drive is signed out or paused, the local file is correct and
 * the cloud copy is stale, and only Drive's own icon will say so.
 */

export { plainReason, type RunOutcome } from './run/state.js';
export { resolveExportCompanies, runExport } from './run/orchestrate.js';
