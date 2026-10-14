import { randomUUID } from 'node:crypto';
import type { ExpectedCounts, ImportCounters } from '../../tally/importResponse.js';
import { TallyError } from '../../tally/TallyError.js';
import type { ToolDeps } from '../shared/toolResult.js';

/**
 * Prepared writes waiting for confirmation.
 *
 * Every write tool runs in two steps. The first call validates the change
 * against the live books, builds the exact XML, and parks it here under a
 * random token — writing NOTHING. Only `tally_confirm_write` with that token
 * sends it. So what an accountant approves is, byte for byte, what reaches
 * TallyPrime: the confirm step cannot be handed different content, because it
 * takes no content at all, only the token.
 */

/** How long a preview stays confirmable. Long enough to review, short enough that the books have not moved on. */
export const PREVIEW_TTL_MS = 15 * 60 * 1000;

/** Bound on parked previews per client, oldest dropped first. */
const MAX_PENDING = 50;

/** What a confirmed write did, as established by reading the books back. */
export interface ReadBack {
  /** True only when the read-back shows exactly the intended state. */
  confirmed: boolean;
  /** What was found, for the answer and the log. */
  detail: unknown;
}

export interface PreparedWrite {
  /** The write tool that prepared this, e.g. "tally_create_ledger". */
  tool: string;
  /** TallyPrime's own spelling of the target company. */
  company: string;
  /** One line, accountant-readable: what this write does. */
  summary: string;
  /** The full accountant-readable preview shown before confirming. */
  preview: Record<string, unknown>;
  /** The exact import envelope that will be sent. */
  body: string;
  /** Which import counters must move, and by how much, for this to be a success. */
  expect: ExpectedCounts;
  /**
   * Re-run just before sending, against freshly-read books. Throws
   * WRITE_CONFLICT when the preview no longer describes what would happen —
   * the ledger now exists, the voucher was altered meanwhile, and so on.
   */
  recheck: (deps: ToolDeps) => Promise<void>;
  /**
   * Read the books back after a write and say whether the intended state is there.
   *
   * `counters` is TallyPrime's reply when there was one — a created voucher is
   * found by the MasterId in it — and null when the send timed out.
   */
  verify: (deps: ToolDeps, counters: ImportCounters | null) => Promise<ReadBack>;
  /** How to reverse this write, in words, for the answer and the log. Absent when there is no clean reverse. */
  undo?: string;
}

interface Parked {
  write: PreparedWrite;
  expiresAt: number;
}

const pendingByClient = new WeakMap<object, Map<string, Parked>>();

/** Park a prepared write and return its token and expiry. */
export function park(deps: ToolDeps, write: PreparedWrite): { token: string; expiresAt: string } {
  let pending = pendingByClient.get(deps.client);
  if (pending === undefined) {
    pending = new Map();
    pendingByClient.set(deps.client, pending);
  }

  const now = Date.now();
  for (const [token, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(token);
  }
  while (pending.size >= MAX_PENDING) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }

  const token = randomUUID();
  const expiresAt = now + PREVIEW_TTL_MS;
  pending.set(token, { write, expiresAt });
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

/**
 * Take a prepared write out, so it can be used exactly once.
 *
 * Removed BEFORE it is sent, not after: if the send times out and the caller
 * retries the confirm, the token is already gone and the retry is refused —
 * which is the point, because a retried import can post twice.
 */
export function take(deps: ToolDeps, token: string): PreparedWrite {
  const pending = pendingByClient.get(deps.client);
  const entry = pending?.get(token);
  pending?.delete(token);

  if (entry === undefined || entry.expiresAt <= Date.now()) {
    throw new TallyError(
      'WRITE_TOKEN_INVALID',
      entry === undefined
        ? 'No prepared change has that confirmation token. It may already have been used — check ' +
            'tally_list_write_log before preparing it again, so nothing is posted twice.'
        : 'That preview has expired, so it was not written.'
    );
  }
  return entry.write;
}
