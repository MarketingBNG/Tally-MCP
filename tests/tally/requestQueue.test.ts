import { describe, it, expect } from 'vitest';
import { RequestQueue } from '../../src/tally/requestQueue.js';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('RequestQueue', () => {
  it('runs tasks one at a time even when submitted together', async () => {
    // This is the whole point: Tally serves one request at a time, so
    // overlapping execution here would mean overlapping requests there.
    const queue = new RequestQueue();
    let running = 0;
    let maxConcurrent = 0;

    const task = async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await tick(10);
      running -= 1;
    };

    await Promise.all([queue.run(task), queue.run(task), queue.run(task), queue.run(task)]);

    expect(maxConcurrent).toBe(1);
  });

  it('preserves submission order', async () => {
    const queue = new RequestQueue();
    const order: number[] = [];

    await Promise.all([
      queue.run(async () => {
        await tick(30);
        order.push(1);
      }),
      queue.run(async () => {
        await tick(5);
        order.push(2);
      }),
      queue.run(() => {
        order.push(3);
        return Promise.resolve();
      }),
    ]);

    expect(order).toEqual([1, 2, 3]);
  });

  it('returns each task its own resolved value', async () => {
    const queue = new RequestQueue();
    const results = await Promise.all([
      queue.run(() => Promise.resolve('a')),
      queue.run(() => Promise.resolve('b')),
    ]);
    expect(results).toEqual(['a', 'b']);
  });

  it('does not let one failure strand the requests behind it', async () => {
    const queue = new RequestQueue();

    const failed = queue.run(() => Promise.reject(new Error('tally exploded')));
    const after = queue.run(() => Promise.resolve('still works'));

    await expect(failed).rejects.toThrow('tally exploded');
    await expect(after).resolves.toBe('still works');
  });

  it('delivers a rejection only to its own caller', async () => {
    const queue = new RequestQueue();
    const results = await Promise.allSettled([
      queue.run(() => Promise.reject(new Error('boom'))),
      queue.run(() => Promise.resolve('fine')),
    ]);

    expect(results[0]?.status).toBe('rejected');
    expect(results[1]?.status).toBe('fulfilled');
  });

  it('tracks depth and returns to zero once drained', async () => {
    const queue = new RequestQueue();
    expect(queue.depth).toBe(0);

    const pending = [queue.run(() => tick(10)), queue.run(() => tick(10))];
    expect(queue.depth).toBe(2);

    await Promise.all(pending);
    expect(queue.depth).toBe(0);
  });

  it('handles a task that throws synchronously', async () => {
    const queue = new RequestQueue();
    const thrown = queue.run(() => {
      throw new Error('sync failure');
    });

    await expect(thrown).rejects.toThrow('sync failure');
    await expect(queue.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});
