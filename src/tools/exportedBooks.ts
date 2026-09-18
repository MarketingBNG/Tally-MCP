import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  findExportedCompany,
  listExportedCompanies,
  listExportedTables,
  readExportedTable,
} from '../export/read.js';
import { TallyError } from '../tally/TallyError.js';
import { companySchema, READ_ONLY_NOTICE, UNTRUSTED_CONTENT_NOTICE } from '../schemas/common.js';
import { runTool, whole, type ToolDeps } from './toolResult.js';
import { openTallyAdvice, waitForTally } from '../tally/waitForTally.js';

/**
 * Answering from the exported files on this machine, with TallyPrime closed.
 *
 * ## What changed, and why it matters
 *
 * The export was built to be read through Google Drive, so the folder somebody
 * picked in Setup silently decided whether Claude could read it at all. Pick a
 * local folder and everything reported success — Setup, the scheduled task, the
 * doctor, the files themselves — while Claude had no path to any of it.
 *
 * The server runs on the machine that writes those files, so it can simply open
 * them. These tools are that. Drive is now a SHARING choice (a colleague on
 * another computer, or Claude on the web) rather than the difference between a
 * working install and a broken one.
 *
 * ## The rule every answer here obeys
 *
 * A file is a SNAPSHOT, not the books. Every response carries `asAt` — the
 * moment TallyPrime was last read — and says in plain words that figures must
 * be quoted as at that time. An accountant citing a number needs to know
 * whether it is from this morning or from a run that stopped succeeding on
 * Tuesday, and nothing else in the answer would tell them.
 */

/**
 * When a snapshot is old enough that the answer has to lead with its age.
 *
 * Not a correctness threshold — a stale file is not wrong, it is merely OLD,
 * and it still answers a question about last year perfectly well. It is an
 * ATTENTION threshold: past a couple of days the likeliest explanation is that
 * the export has stopped running, and somebody should be told that rather than
 * left to notice it from a timestamp.
 */
const STALE_AFTER_HOURS = 48;

const LIST_DESCRIPTION = [
  'List the companies whose exported spreadsheets are on this computer, with the moment each ' +
    'was last read from TallyPrime.',
  '',
  'WHEN TO USE: as the FIRST call when TallyPrime is closed or unreachable, and before ' +
    'answering anything from the exported files. It is also the cheapest way to see how old ' +
    'the data is.',
  '',
  'RETURNS: for each company, TallyPrime own spelling of its name, the currency its books are ' +
    'in, and the "as at" moment of the last successful export.',
  '',
  'DOES NOT RETURN: live figures. Everything here is a snapshot written by the scheduled ' +
    'export. If the books changed since, these files do not know. Quote figures as at the ' +
    'timestamp given, never as "now".',
  '',
  'WORKS WITH TALLYPRIME CLOSED: yes. This reads files on disk and never contacts Tally.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

const READ_DESCRIPTION = [
  'Read one table out of a company exported spreadsheet on this computer.',
  '',
  'WHEN TO USE: after tally_list_exported_books has told you which companies exist. Call it ' +
    'once with no `table` to see the catalogue of tables and their row counts, then again ' +
    'naming the one you want.',
  '',
  'RETURNS: the table column headings and its rows, as text exactly as exported, plus the ' +
    '"as at" moment the figures were read from TallyPrime.',
  '',
  'PAGINATION: `offset` and `limit` (default 500 rows). `totalRows` is always the count in the ' +
    'FILE, not in the page returned — do not report it as the number of rows the company has ' +
    'if `truncated` is true.',
  '',
  'DOES NOT RETURN: live figures, or anything the export did not write. Values arrive as TEXT, ' +
    'including amounts; convert before arithmetic.',
  '',
  'WORKS WITH TALLYPRIME CLOSED: yes.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

/**
 * Describe a snapshot's age in words a person can act on.
 *
 * The timestamp alone is not enough. "2026-09-15T18:05:00" beside a figure
 * reads as provenance rather than as a warning, and the thing worth noticing —
 * that this has not updated in four days — is exactly what a reader skims past.
 */
function describeAge(asAt: string | null, now: Date): string {
  if (asAt === null) {
    return (
      'UNKNOWN AGE. This export does not record when it was read from TallyPrime, so how ' +
      'current it is cannot be established. Treat every figure as undated.'
    );
  }

  const when = new Date(asAt);
  if (Number.isNaN(when.getTime())) {
    return `Recorded as "${asAt}", which could not be read as a date. Treat the age as unknown.`;
  }

  const hours = (now.getTime() - when.getTime()) / (1000 * 60 * 60);

  if (hours < 0) {
    // A clock difference, not a fresher file. Saying "in 3 hours" would be
    // absurd; saying it is current would be a guess.
    return `Stamped ${asAt}, which is in the future on this computer clock. Treat the age as unknown.`;
  }

  if (hours >= STALE_AFTER_HOURS) {
    return (
      `STALE: last read from TallyPrime ${asAt}, which is ${String(Math.floor(hours / 24))} ` +
      'day(s) ago. The scheduled export may have stopped running. Say so when quoting any ' +
      'figure from it, and prefer live TallyPrime if it can be opened.'
    );
  }

  return `Last read from TallyPrime ${asAt}. Quote figures as at that moment, not as "now".`;
}

/**
 * The one sentence that must accompany any figure from these files.
 *
 * Repeated on every response rather than stated once in the tool description,
 * because a description is read when the tool is chosen and this has to be in
 * front of whoever is writing the sentence that quotes the number.
 */
const SNAPSHOT_NOTICE =
  'These figures come from an exported file, not from live TallyPrime. They are correct as at ' +
  'the "asAt" moment given and say nothing about the books since.';

/**
 * Explain an export folder that yielded nothing, in terms of what to do next.
 *
 * Four different situations arrive here looking identical — never set up, set
 * up but never run, folder on a drive that is not connected, folder emptied —
 * and the difference decides whether somebody opens Tally, runs Setup, or plugs
 * in a drive. So the message names the folder and covers the possibilities
 * rather than reporting "no data".
 */
async function noBooksError(
  deps: ToolDeps,
  exportFolder: string | undefined
): Promise<TallyError> {
  // Asked BEFORE the message is written, so it can say which of the two routes
  // is actually open rather than listing both and leaving the user to find out.
  const live = await waitForTally(deps);

  if (exportFolder === undefined || exportFolder.trim() === '') {
    return new TallyError(
      'EXPORT_NOT_CONFIGURED',
      'No export folder has been set up on this computer, so there are no exported ' +
        'spreadsheets to read.',
      {
        suggestion: fallbackAdvice(
          live,
          'Run Setup and choose a folder for the daily spreadsheet.'
        ),
      }
    );
  }

  return new TallyError(
    'EXPORT_NO_COMPANIES',
    `The export folder on this computer holds no exported company data:\n  ${exportFolder}`,
    {
      suggestion: fallbackAdvice(
        live,
        'This usually means one of: the export has not run yet; the folder is on a drive that ' +
          'is not connected right now; or the folder was moved or emptied. Check that folder in ' +
          'File Explorer.'
      ),
    }
  );
}

/**
 * What to do when the files cannot answer, given what live TallyPrime is doing.
 *
 * The two halves are deliberately separate. `fileRemedy` repairs the FILES,
 * which is the durable fix and the only thing that restores answering with
 * Tally closed. The live route is how to get an answer in the next minute.
 *
 * Which one leads depends on the probe rather than on a guess, because the
 * difference matters: telling somebody to open TallyPrime when it is already
 * open sends them to check the wrong thing, and offering the live books when
 * Tally is shut offers something that is not there.
 */
function fallbackAdvice(
  live: { available: boolean; attempts: number },
  fileRemedy: string
): string {
  if (live.available) {
    return (
      'TallyPrime IS open and answering, so ask the question again and it will be answered ' +
      'from the LIVE books — say that is where the figures came from. ' +
      `To restore answering with TallyPrime closed: ${fileRemedy}`
    );
  }

  return `${openTallyAdvice(live)}\n\nOr, to restore the exported files: ${fileRemedy}`;
}

export function registerExportedBookTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_list_exported_books',
    { description: LIST_DESCRIPTION, inputSchema: z.object({}) },
    async () =>
      runTool('tally_list_exported_books', deps, async () => {
        const folder = deps.config.tallyExportFolder;
        const companies = listExportedCompanies(folder);

        if (companies.length === 0) throw await noBooksError(deps, folder);

        const now = new Date();

        return (
          whole(
            {
              exportFolder: folder,
              companies: companies.map((entry) => ({
                company: entry.company,
                currency: entry.currency,
                asAt: entry.asAt,
                freshness: describeAge(entry.asAt, now),
              })),
              notice: SNAPSHOT_NOTICE,
            },
            companies.length
          )
        );
      })
  );

  server.registerTool(
    'tally_read_exported_table',
    {
      description: READ_DESCRIPTION,
      inputSchema: z.object({
        company: companySchema,
        table: z
          .string()
          .optional()
          .describe(
            'The table filename exactly as the catalogue lists it, such as "Ledgers.csv". ' +
              'Omit to receive the catalogue of tables instead of a table.'
          ),
        offset: z.number().int().min(0).optional().describe('Rows to skip. Defaults to 0.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe('Rows to return. Defaults to 500.'),
      }),
    },
    async (args) =>
      runTool('tally_read_exported_table', deps, async () => {
        const folder = deps.config.tallyExportFolder;
        const target = findExportedCompany(folder, args.company);

        if (target === null) {
          const available = listExportedCompanies(folder);
          if (available.length === 0) throw await noBooksError(deps, folder);

          const names =
            'Exported here: ' + available.map((entry) => `"${entry.company}"`).join(', ') + '.';

          // Naming none while several are here is a question with no answer, and
          // no fallback fixes it — the live books would be no less ambiguous.
          // Only the MISSING-company case is worth asking Tally about.
          if (args.company === undefined) {
            throw new TallyError(
              'EXPORT_COMPANY_NOT_FOUND',
              `This computer holds exported data for ${String(available.length)} companies, so ` +
                '"which company?" has no single answer.',
              {
                suggestion:
                  `Name one. ${names} Names must match TallyPrime own spelling, which ` +
                  'tally_list_exported_books reports.',
              }
            );
          }

          // A company nobody has exported is exactly the question the live books
          // exist to answer — so whether they can be reached is asked here rather
          // than left for the user to discover by trying.
          const live = await waitForTally(deps);

          throw new TallyError(
            'EXPORT_COMPANY_NOT_FOUND',
            `This computer holds no exported data for "${args.company}".`,
            {
              suggestion: live.available
                ? `TallyPrime IS open, so ask for this company from the LIVE books — use ` +
                  'tally_list_companies to confirm it is loaded, then the ordinary tools. Say ' +
                  `the figures came from live TallyPrime, not from a file. ${names}`
                : `${openTallyAdvice(live)}

${names}`,
            }
          );
        }

        const now = new Date();
        const freshness = describeAge(target.asAt, now);

        if (args.table === undefined) {
          const tables = listExportedTables(target);
          return (
            whole(
              {
                company: target.company,
                asAt: target.asAt,
                freshness,
                tables,
                notice: SNAPSHOT_NOTICE,
              },
              tables.length
            )
          );
        }

        // Spread conditionally rather than passing `undefined` through: the
        // reader's defaults are the single place the page size is decided, and
        // an explicit `undefined` under exactOptionalPropertyTypes is a
        // different thing from an absent key.
        const data = readExportedTable(target, args.table, {
          ...(args.offset === undefined ? {} : { offset: args.offset }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        });

        return (
          whole(
            {
              company: target.company,
              currency: target.currency,
              asAt: target.asAt,
              freshness,
              ...data,
              notice: SNAPSHOT_NOTICE,
            },
            data.rows.length
          )
        );
      })
  );
}
