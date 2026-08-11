/**
 * Single-flight request queue.
 *
 * TallyPrime's HTTP listener effectively serves one request at a time.
 * Claude routinely issues several tool calls in parallel, and concurrent
 * requests to Tally block, time out, or return truncated bodies — which
 * presents as random flakiness rather than a design problem.
 *
 * Every outbound request goes through here, so exactly one is in flight
 * regardless of how many tools Claude invokes at once. This is a throughput
 * ceiling by design; it is documented in the README as a known constraint.
 */
export class RequestQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #depth = 0;

  /** Number of tasks queued or running. Useful for logging and tests. */
  get depth(): number {
    return this.#depth;
  }

  /**
   * Run `task` once all previously enqueued tasks have settled.
   *
   * A rejected task does not poison the queue: the chain continues with the
   * next task, and the rejection is delivered only to its own caller.
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    this.#depth += 1;

    const result = this.#tail.then(task, task);

    // Keep the chain alive regardless of outcome, so one failure does not
    // strand every request behind it.
    this.#tail = result.then(
      () => undefined,
      () => undefined
    );

    return result.finally(() => {
      this.#depth -= 1;
    });
  }
}
