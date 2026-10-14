import {
  judgeImport,
  parseImportResponse,
  type ImportCounters,
} from '../../tally/importResponse.js';
import { forgetWithinCall } from '../../tally/queryLog.js';
import { TallyError } from '../../tally/TallyError.js';
import { parsedVoucherCache } from '../read/vouchers/fetch.js';
import { forgetParsedCollections } from '../shared/result/collections.js';
import {
  assertCompanyIsLoaded,
  whole,
  type ToolBodyResult,
  type ToolDeps,
} from '../shared/toolResult.js';
import { markEducationalMode } from '../shared/educationalMode.js';
import { park, take, type PreparedWrite, type ReadBack } from './pending.js';
import { appendWriteLog, type WriteLogEntry, type WriteOutcome } from './writeLog.js';

/**
 * The two halves of every write: preview, then confirm.
 */

/** The standing notice every write tool's description ends with. */
export const WRITE_NOTICE =
  'WRITES TO TALLYPRIME, in two steps. This call only PREVIEWS: it checks the change against the ' +
  'live books and returns exactly what would be written plus a confirmToken — nothing is changed. ' +
  'Show the preview to the user, and only after they approve it call tally_confirm_write with the ' +
  'token. Never confirm on your own initiative, and never confirm a preview the user has not seen.';

/**
 * Forget everything read from TallyPrime so far.
 *
 * Four caches sit between a tool and the books — the client's response cache,
 * the per-call memo and the two parse caches — and after a write any of them can be describing
 * books that no longer exist. Called before a recheck (so it reads the books as
 * they are now) and after every write.
 */
export function invalidateAfterWrite(deps: ToolDeps): void {
  deps.client.clearCache();
  forgetWithinCall();
  forgetParsedCollections(deps.client);
  parsedVoucherCache.delete(deps.client);
}

/** First step: park a prepared write and return its preview. Writes nothing. */
export function previewResult(deps: ToolDeps, write: PreparedWrite): ToolBodyResult {
  const { token, expiresAt } = park(deps, write);
  return whole(
    {
      status: 'PREVIEW ONLY — nothing has been written to TallyPrime.',
      company: write.company,
      summary: write.summary,
      ...write.preview,
      ...(write.undo === undefined ? {} : { howToUndo: write.undo }),
      confirmToken: token,
      expiresAt,
      next:
        'Show this preview to the user. If they approve it, call tally_confirm_write with this ' +
        'confirmToken. To change anything, call this tool again instead.',
    },
    1
  );
}

/**
 * Second step: send a prepared write, judge it, read it back and log it.
 *
 * The order is the safety argument:
 *   1. the token is consumed first, so a retried confirm cannot send twice;
 *   2. the company must still be the one loaded;
 *   3. the preview is re-checked against freshly-read books (WRITE_CONFLICT);
 *   4. one send, never retried;
 *   5. success is judged on exact counters, not on the absence of an error;
 *   6. the books are read back, and every outcome is logged before answering.
 */
export async function confirmWrite(deps: ToolDeps, token: string): Promise<ToolBodyResult> {
  const write = take(deps, token);

  const loaded = await assertCompanyIsLoaded(deps, write.company);
  if (loaded !== write.company) {
    throw new TallyError(
      'WRITE_CONFLICT',
      `This change was prepared for "${write.company}", which is not the company TallyPrime has open.`
    );
  }

  invalidateAfterWrite(deps);
  await write.recheck(deps);

  const log = (
    outcome: WriteOutcome,
    responseXml: string | null,
    problems: string[],
    readBack: unknown
  ): string | null => {
    const entry: WriteLogEntry = {
      at: new Date().toISOString(),
      tool: write.tool,
      company: write.company,
      outcome,
      summary: write.summary,
      preview: write.preview,
      requestXml: write.body,
      responseXml,
      problems,
      readBack,
      undo: write.undo ?? null,
    };
    try {
      appendWriteLog(deps.config, entry);
      return null;
    } catch (error) {
      deps.logger.error('could not append to the write log', { error: String(error) });
      return 'WARNING: this write could not be recorded in the local write log.';
    }
  };

  let responseXml: string;
  try {
    responseXml = (await deps.client.sendWrite(write.body)).body;
  } catch (error) {
    const failure = TallyError.from(error, 'The write could not be sent.');
    invalidateAfterWrite(deps);
    // Refused at the socket: nothing reached TallyPrime, so nothing was written.
    if (failure.code === 'TALLY_NOT_RUNNING') {
      log('REJECTED', null, [failure.message], null);
      throw failure;
    }
    // Anything else — a timeout above all — may have been written. Find out.
    const readBack = await safeVerify(deps, write, null);
    const logWarning = log('OUTCOME_UNKNOWN', null, [failure.message], readBack);
    throw new TallyError(
      'WRITE_OUTCOME_UNKNOWN',
      `${failure.message} The change may or may not have been written. Reading the books back ` +
        `found: ${describeReadBack(readBack)}.${logWarning === null ? '' : ` ${logWarning}`}`,
      { cause: error }
    );
  }

  invalidateAfterWrite(deps);
  const counters = parseImportResponse(responseXml);
  const judgement = judgeImport(counters, write.expect);

  if (!judgement.ok) {
    const isVoucher = write.body.includes('<REPORTNAME>Vouchers</REPORTNAME>');
    if (isVoucher && counters.lineErrors.some((line) => /voucher date is missing/i.test(line))) {
      markEducationalMode(write.company);
    }
    judgement.problems.push(...explainProblems(counters));
    const rejectedVoucher = isVoucher && counters.exceptions > 0;
    const readBack = judgement.unexpectedChange ? await safeVerify(deps, write, counters) : null;
    const logWarning = log(
      judgement.unexpectedChange ? 'UNEXPECTED_CHANGE' : 'REJECTED',
      responseXml,
      judgement.problems,
      readBack
    );
    throw new TallyError(
      judgement.unexpectedChange ? 'WRITE_CONFLICT' : 'WRITE_REJECTED',
      (judgement.unexpectedChange
        ? 'TallyPrime CHANGED THE BOOKS DIFFERENTLY FROM THE PREVIEW. '
        : rejectedVoucher
          ? 'TallyPrime refused the voucher; it is not in the books. BUT TallyPrime may keep a ' +
            'hidden trace of a rejected voucher that stops the ledgers it named from being deleted ' +
            'later. Do not resend it unchanged. '
          : 'TallyPrime refused the change; nothing was written. ') +
        judgement.problems.join(' ') +
        (logWarning === null ? '' : ` ${logWarning}`),
      judgement.unexpectedChange
        ? {
            suggestion:
              'Check the affected record in TallyPrime now. The write log holds the exact request ' +
              'and reply.',
          }
        : {}
    );
  }

  const readBack = await safeVerify(deps, write, counters);
  const logWarning = log('WRITTEN', responseXml, [], readBack);

  return whole(
    {
      status: readBack.confirmed
        ? 'WRITTEN and confirmed by reading the books back.'
        : 'TallyPrime reported the write as done, but reading the books back did NOT show the ' +
          'expected result. Check it in TallyPrime.',
      company: write.company,
      summary: write.summary,
      tallyReported: {
        created: counters.created,
        altered: counters.altered,
        deleted: counters.deleted,
        cancelled: counters.cancelled,
        ...(counters.lastVoucherId > 0 ? { voucherMasterId: counters.lastVoucherId } : {}),
      },
      readBack: readBack.detail,
      ...(write.undo === undefined ? {} : { howToUndo: write.undo }),
      ...(logWarning === null ? {} : { warning: logWarning }),
    },
    1
  );
}

/**
 * Plain-language notes for TallyPrime replies that mislead on their own.
 *
 * Both verified live 2026-10-14. TallyPrime in Educational mode accepts voucher
 * dates only on the 1st, 2nd and 31st, and reports any other date as "Voucher
 * date is missing" — which sends an accountant looking for a date that is there.
 * And an alter aimed at a voucher that no longer exists is not refused: Tally
 * CREATES a new voucher, so the caller must be told exactly which one to remove.
 */
function explainProblems(counters: ImportCounters): string[] {
  const notes: string[] = [];
  if (counters.lineErrors.some((line) => /voucher date is missing/i.test(line))) {
    notes.push(
      'NOTE: the date WAS sent. TallyPrime gives this message when it rejects the date itself — ' +
        'most often because it is running in Educational mode, which only allows the 1st, 2nd and ' +
        '31st of a month, or because the date is outside the books.'
    );
  }
  if (counters.lineErrors.some((line) => /cannot be deleted/i.test(line))) {
    // TallyPrime gives no reason. Verified live 2026-10-14: ledgers whose vouchers
    // had all been deleted (or cancelled then deleted) DID delete, so "it once had
    // vouchers" is not the rule — but two test ledgers stayed undeletable with no
    // voucher referencing them, for a reason never established.
    notes.push(
      'NOTE: TallyPrime gives no reason here. Usually the master is still in use — a ledger with ' +
        'vouchers, a group with ledgers or sub-groups under it, a unit an item uses. If nothing ' +
        'visibly uses it, try deleting it in TallyPrime itself, which shows the reason on screen.'
    );
  }
  if (counters.created > 0 && counters.lastVoucherId > 0) {
    notes.push(
      `TallyPrime CREATED a voucher (MasterId ${String(counters.lastVoucherId)}) that was not ` +
        'asked for. Review it, and remove it with tally_delete_voucher if it should not exist.'
    );
  }
  if (counters.exceptions > 0 && counters.lineErrors.length === 0) {
    notes.push(
      'TallyPrime gave no reason. For a voucher the usual causes are debits not equalling credits, ' +
        'a ledger or voucher type that does not exist, or a date outside the books.'
    );
  }
  return notes;
}

/** Verify without letting a read failure hide the write's own outcome. */
async function safeVerify(
  deps: ToolDeps,
  write: PreparedWrite,
  counters: ImportCounters | null
): Promise<ReadBack> {
  try {
    return await write.verify(deps, counters);
  } catch (error) {
    return {
      confirmed: false,
      detail: `the books could not be read back (${TallyError.from(error, 'read-back failed').message})`,
    };
  }
}

function describeReadBack(readBack: ReadBack): string {
  return typeof readBack.detail === 'string' ? readBack.detail : JSON.stringify(readBack.detail);
}
