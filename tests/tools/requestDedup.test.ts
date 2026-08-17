import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  makeDeps,
  fixture,
  createToolRegistry,
  callToolEnvelope,
  type ToolRegistry,
} from './harness.js';
import { registerReportTools } from '../../src/tools/reports.js';
import { registerMasterTools } from '../../src/tools/masters.js';

/**
 * One tool call, one copy of each request.
 *
 * Answering a single question makes the same request several times over:
 * resolving the loaded company, then its book year, then its currency each send
 * the identical company-list request. The response cache hid the cost, but it
 * is TTL-gated — so with `TALLY_CACHE_TTL_MS=0` every duplicate became a real
 * round trip through a queue that admits one request at a time.
 *
 * These pin both halves of the fix: that the duplicates are gone, and that
 * removing them changed nothing about the answer. The second half is the one
 * that matters — a dedup that quietly altered a figure would be worse than the
 * duplicates it removed.
 */

let mock: MockTallyServer;
let port: number;

beforeAll(async () => {
  mock = new MockTallyServer();
  port = await mock.start();
});

afterAll(async () => {
  await mock.stop();
});

/** Route by the report/collection ID in the request, as real Tally does. */
function serveDefaults(): void {
  mock.onBodyContaining('List of Companies', { body: fixture('company-list.xml') });
  mock.onBodyContaining('<ID>Ledgers</ID>', { body: fixture('ledger-list.xml') });
  mock.onBodyContaining('Trial Balance', { body: fixture('trial-balance.xml') });
}

beforeEach(() => {
  mock.reset();
  serveDefaults();
});

function registryFor(overrides: Record<string, string> = {}): ToolRegistry {
  const registry = createToolRegistry();
  const deps = makeDeps(port, overrides);
  registerMasterTools(registry.server, deps);
  registerReportTools(registry.server, deps);
  return registry;
}

/** The number of times the most-repeated request body actually reached Tally. */
function worstDuplication(): number {
  const counts = new Map<string, number>();
  for (const request of mock.requests) {
    counts.set(request.body, (counts.get(request.body) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

/** The two clocks that legitimately differ between two runs. */
function stripClocks(envelope: Record<string, unknown>): Record<string, unknown> {
  const { as_of_timestamp: _asOf, data_fetched_at: _fetched, ...rest } = envelope;
  return rest;
}

describe('request de-duplication within one tool call', () => {
  it('sends each distinct request once, even with the response cache off', async () => {
    await callToolEnvelope(registryFor({ TALLY_CACHE_TTL_MS: '0' }), 'tally_get_statement', {
      statement: 'trial_balance',
    });

    expect(worstDuplication()).toBe(1);
  });

  it('de-duplicates the master fetch path too', async () => {
    await callToolEnvelope(registryFor({ TALLY_CACHE_TTL_MS: '0' }), 'tally_get_masters', {
      type: 'ledger',
    });

    expect(worstDuplication()).toBe(1);
  });

  it('returns exactly the same envelope with the cache off as with it on', async () => {
    const withCache = await callToolEnvelope(registryFor(), 'tally_get_statement', {
      statement: 'trial_balance',
    });

    mock.reset();
    serveDefaults();

    const withoutCache = await callToolEnvelope(
      registryFor({ TALLY_CACHE_TTL_MS: '0' }),
      'tally_get_statement',
      { statement: 'trial_balance' }
    );

    expect(stripClocks(withoutCache)).toEqual(stripClocks(withCache));
  });

  it('still records every request as provenance', async () => {
    // De-duplicating the WIRE must not de-duplicate the audit trail: the
    // envelope has to keep naming the requests that produced its figures.
    const envelope = await callToolEnvelope(
      registryFor({ TALLY_CACHE_TTL_MS: '0' }),
      'tally_get_statement',
      { statement: 'trial_balance' }
    );

    const queries = envelope.source_query as string[];
    expect(queries.some((query) => query.includes('List of Companies'))).toBe(true);
    expect(queries.some((query) => query.includes('Trial Balance'))).toBe(true);
  });
});
