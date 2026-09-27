import type { AppConfig } from '../config/config.js';
import type { Logger } from '../utils/logger.js';
import { TallyError } from './TallyError.js';
import type { RequestClass, TallyResponse } from './TallyClient.js';

/**
 * What happens after TallyPrime times out: wait for it, then ask again.
 *
 * ## Why a timeout cannot simply be reported
 *
 * TallyPrime cannot abandon a request. When the client gives up, Tally goes on
 * building the answer, and anything sent meanwhile queues behind it, times out
 * in turn and adds more work. That is how one slow year turned a working Tally
 * into one that stopped answering altogether. And a timeout that is reported and
 * left there is data that never reaches Claude or the export, which on a set of
 * books is the failure that matters.
 *
 * ## What this does instead
 *
 * 1. After a timeout, nothing more is sent until Tally answers a light probe
 *    again — it has finished the abandoned request. Checked every few seconds,
 *    for up to `tallyBusyWaitMs`.
 * 2. Then the same request goes again with twice the time, up to Tally's
 *    10-minute ceiling, `tallyTimeoutRetries` more times.
 * 3. Only if that still fails does the timeout reach the caller, which names the
 *    dates it could not get rather than presenting a short population as whole.
 *
 * The waiting happens inside the request queue, so every tool and the export
 * wait together: no other request can slip in and join the pile.
 *
 * A Tally that is CLOSED, rather than busy, is not waited on. A refused
 * connection says that at once, and waiting ten minutes for an application
 * nobody is opening would be a hang, not patience.
 */

/** A probe is the company list; anything slower than this means Tally is still busy. */
export const PROBE_TIMEOUT_MS = 10_000;

/** Pause between probes while waiting. */
const PROBE_INTERVAL_MS = 5_000;

/** Tally's own ceiling on a request, matching the TALLY_REPORT_TIMEOUT_MS maximum. */
const MAX_TIMEOUT_MS = 600_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isTimeout = (error: unknown): boolean =>
  error instanceof TallyError && error.code === 'TALLY_TIMEOUT';

export class Patience {
  /** Set by a timeout; cleared once Tally answers a probe again. */
  #busy = false;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly probe: () => Promise<TallyResponse>
  ) {}

  /** Send via `sendOnce`, waiting out a busy Tally and retrying a timeout. */
  async send(
    body: string,
    requestClass: RequestClass,
    sendOnce: (timeoutMs: number) => Promise<TallyResponse>
  ): Promise<TallyResponse> {
    let timeoutMs =
      requestClass === 'report' ? this.config.tallyReportTimeoutMs : this.config.tallyTimeoutMs;

    for (let attempt = 0; ; attempt += 1) {
      if (this.#busy) await this.#waitUntilFree();

      try {
        return await sendOnce(timeoutMs);
      } catch (error) {
        if (!isTimeout(error)) throw error;
        this.#busy = true;
        if (attempt >= this.config.tallyTimeoutRetries) throw error;

        timeoutMs = Math.min(MAX_TIMEOUT_MS, timeoutMs * 2);
        this.logger.warn('TallyPrime timed out; retrying once it is free', {
          requestClass,
          bytes: body.length,
          attempt: attempt + 1,
          nextTimeoutMs: timeoutMs,
        });
      }
    }
  }

  async #waitUntilFree(): Promise<void> {
    const deadline = Date.now() + this.config.tallyBusyWaitMs;
    this.logger.info('waiting for TallyPrime to finish before sending anything else');

    for (;;) {
      try {
        await this.probe();
        this.#busy = false;
        this.logger.info('TallyPrime is free again');
        return;
      } catch (error) {
        // Closed rather than busy: say so now instead of waiting on nothing.
        if (!isTimeout(error)) throw error;
      }

      if (Date.now() + PROBE_INTERVAL_MS > deadline) {
        throw new TallyError(
          'TALLY_TIMEOUT',
          `TallyPrime was still busy after ${String(Math.round(this.config.tallyBusyWaitMs / 60_000))} ` +
            'minutes with an earlier request, so nothing more was sent to it. If it has stopped ' +
            'responding, close and reopen TallyPrime, then ask again.'
        );
      }
      await sleep(PROBE_INTERVAL_MS);
    }
  }
}
