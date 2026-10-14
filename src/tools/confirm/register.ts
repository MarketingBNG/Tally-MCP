import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { runTool, whole, type ToolDeps } from '../shared/toolResult.js';
import { confirmWrite } from './flow.js';
import { readWriteLog, writeLogPath } from './writeLog.js';

/**
 * The confirm step every write goes through, and the log of what was written.
 */
export function registerConfirmTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_confirm_write',
    {
      description:
        'Send ONE previously previewed change to TallyPrime.\n\n' +
        'WHEN TO USE: only after a write tool (tally_create_*, tally_alter_*, tally_cancel_*, ' +
        'tally_delete_*) returned a preview AND the user has seen it and explicitly approved it. ' +
        'Never call this on your own initiative.\n\n' +
        'WHAT IT DOES: re-checks the preview against the live books, sends it exactly once, ' +
        'judges TallyPrime\'s reply, reads the books back to confirm, and records it in the write log.\n\n' +
        'IF IT TIMES OUT or reports WRITE_OUTCOME_UNKNOWN: do NOT prepare and confirm the same change ' +
        'again — it may already be in the books. Check first.\n\n' +
        'A token works once and expires 15 minutes after the preview.',
      inputSchema: z.object({
        confirmToken: z.string().min(1).describe('The confirmToken from the preview the user approved.'),
      }),
    },
    async ({ confirmToken }) =>
      runTool('tally_confirm_write', deps, () => confirmWrite(deps, confirmToken))
  );

  server.registerTool(
    'tally_list_write_log',
    {
      description:
        'List the changes this server has written to TallyPrime on this computer, newest first.\n\n' +
        'WHEN TO USE: to answer "what has been changed in the books", before re-preparing a change ' +
        'whose confirm failed or timed out, or to find how to undo a change.\n\n' +
        'RETURNS: time, company, tool, outcome (WRITTEN, REJECTED, UNEXPECTED_CHANGE, ' +
        'OUTCOME_UNKNOWN), summary, problems, read-back and how to undo. The exact XML sent and ' +
        'TallyPrime\'s reply are included with includeXml.\n\n' +
        'Reads a local file only; does not contact TallyPrime.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional().describe('How many entries. Default 20.'),
        includeXml: z.boolean().optional().describe('Include the request and response XML. Default false.'),
      }),
    },
    async ({ limit, includeXml }) =>
      runTool('tally_list_write_log', deps, () => {
        const entries = readWriteLog(deps.config, limit ?? 20).map((entry) =>
          includeXml === true ? entry : { ...entry, requestXml: undefined, responseXml: undefined }
        );
        return Promise.resolve(whole({ logFile: writeLogPath(deps.config), entries }, entries.length));
      })
  );
}
