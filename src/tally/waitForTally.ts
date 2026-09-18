import { checkConnection } from '../tools/connection.js';
import type { TallyClient } from './TallyClient.js';
import type { AppConfig } from '../config/config.js';
import type { Logger } from '../utils/logger.js';

/**
 * Waiting a little while for TallyPrime to be opened.
 *
 * ## Where this is used
 *
 * On the fallback path. The exported files on this machine answer most
 * questions with Tally closed, but they cannot answer everything — a company
 * that has never been exported, or a period the files do not reach. Those
 * questions need the live books, and the live books need Tally open.
 *
 * ## Why it retries at all
 *
 * Because "TallyPrime was not open" is not a fault. It is closed every evening,
 * every weekend, and all day on the machines of people who open it only when
 * they need it — the same reasoning `notifyOnce.mjs` sets out for the exporter.
 * Somebody who is told to open Tally takes a few seconds to do it, and a probe
 * that gives up on the first refused connection makes them ask the whole
 * question again for no reason.
 *
 * ## Why it retries for SECONDS and not minutes
 *
 * A tool call is one request and one response. There is no way to tell somebody
 * "open TallyPrime" partway through and then carry on waiting — the MCP server
 * SDK here offers only `sendLoggingMessage`, which reaches the client's log
 * rather than the person. So a long wait is not patience, it is a silent stall:
 * Claude sits there, the user is told nothing, and the client eventually times
 * out with no answer at all.
 *
 * The bound below is therefore chosen to cover the case that actually happens —
 * somebody opening Tally right now, having been asked to on the previous
 * answer — and to fail quickly and clearly otherwise, so the next thing the
 * user sees is a sentence telling them what to do.
 *
 * ## What it must never do
 *
 * Retry a company that is not loaded. Tally being shut is a condition that
 * changes by itself once somebody clicks the icon; the wrong company being open
 * is not, and `prompts.ts` already says so — no amount of retrying loads a
 * company, and waiting on it only delays the message that would have fixed it.
 * So this waits on REACHABILITY only, and says nothing about which books are
 * loaded.
 */

/** How many times the probe is attempted, the first one included. */
const MAX_ATTEMPTS = 3;

/**
 * How long to wait between attempts.
 *
 * A refused TCP connection comes back in a fraction of a second, so the waiting
 * is almost all of the elapsed time: three attempts is roughly two and a half
 * seconds in total. Long enough for somebody already reaching for the icon,
 * short enough that a closed Tally is reported promptly rather than felt as a
 * hang.
 */
const RETRY_DELAY_MS = 1200;

export interface TallyAvailability {
  /** Whether TallyPrime answered. */
  available: boolean;
  /** How many probes were made, for the log and for an honest message. */
  attempts: number;
  /** Why the last attempt failed, in the plain words the probe produced. */
  reason?: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Probe TallyPrime, retrying briefly if it is not answering.
 *
 * Never throws: an unreachable Tally is an ANSWER here, not an error. The
 * caller has to explain it in the context of what was being asked, and can only
 * do that if it gets a result to read rather than an exception to catch.
 */
export async function waitForTally(deps: {
  client: TallyClient;
  config: AppConfig;
  logger: Logger;
}): Promise<TallyAvailability> {
  let reason: string | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const status = await checkConnection(deps);

    if (status.connected) {
      // Logged because a fallback that needed two attempts is worth seeing in a
      // diagnosis — it means somebody was opening Tally as they were asked to.
      if (attempt > 1) {
        deps.logger.info('TallyPrime became reachable while waiting', { attempts: attempt });
      }
      return { available: true, attempts: attempt };
    }

    reason = status.error?.message ?? 'TallyPrime did not answer.';

    // No sleep after the last attempt: waiting after the final probe delays the
    // answer without ever being able to change it.
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }

  deps.logger.info('TallyPrime stayed unreachable', { attempts: MAX_ATTEMPTS });

  return {
    available: false,
    attempts: MAX_ATTEMPTS,
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * The sentence to put in front of somebody when Tally has to be opened.
 *
 * Says that it was tried more than once, because "could not reach TallyPrime"
 * alone invites the reasonable suspicion that it was checked at the wrong
 * moment. And it says what happens next — asking again is all that is needed,
 * there is nothing to reconfigure.
 */
export function openTallyAdvice(availability: TallyAvailability): string {
  return (
    `TallyPrime is not answering — it was tried ${String(availability.attempts)} times over a ` +
    'few seconds.\n\n' +
    'What to do: open TallyPrime, load the company, and ask again. Nothing needs to be ' +
    'reconfigured; the question will be answered from the live books as soon as Tally is up.'
  );
}
