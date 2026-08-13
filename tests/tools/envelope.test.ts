import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolEnvelope,
  callToolError,
  createToolRegistry,
  fixture,
  makeDeps,
  type ToolRegistry,
} from './harness.js';
import { registerConnectionTools } from '../../src/tools/connection.js';
import { registerCompanyTools } from '../../src/tools/companies.js';
import { registerLedgerTools } from '../../src/tools/ledgers.js';
import { registerGroupTools } from '../../src/tools/groups.js';
import { registerReportTools } from '../../src/tools/reports.js';
import { registerVoucherTools } from '../../src/tools/vouchers.js';
import { registerInventoryTools } from '../../src/tools/inventory.js';
import { registerOutstandingTools } from '../../src/tools/outstanding.js';
import { registerGstTools } from '../../src/tools/gst.js';
import { registerSearchTools } from '../../src/tools/search.js';
import { registerLedgerTransactionTools } from '../../src/tools/ledgerTransactions.js';
import { registerPartyStatementTools } from '../../src/tools/partyStatement.js';
import { registerTieOutTools } from '../../src/tools/tieOut.js';
import { registerMaterialityTools } from '../../src/tools/materiality.js';

/**
 * Conformance with Build Specification v1.0 §4 and §6.
 *
 * These tests are deliberately about the SHAPE every tool returns rather than
 * about any one tool's data. §6 rule 4 exists because a sibling connector
 * truncated silently and a wrong figure reached a client workpaper; the defence
 * only works if it is uniform, so the enumeration below drives itself from the
 * tool registry. A tool added later without an envelope fails here without
 * anyone remembering to add a test for it.
 */

let mock: MockTallyServer;
let port: number;

function build(overrides: Record<string, string> = {}): ToolRegistry {
  return buildOn(port, overrides);
}

function buildOn(onPort: number, overrides: Record<string, string> = {}): ToolRegistry {
  const registry = createToolRegistry();
  const deps = makeDeps(onPort, overrides);

  registerConnectionTools(registry.server, deps);
  registerCompanyTools(registry.server, deps);
  registerLedgerTools(registry.server, deps);
  registerGroupTools(registry.server, deps);
  registerReportTools(registry.server, deps);
  registerVoucherTools(registry.server, deps);
  registerInventoryTools(registry.server, deps);
  registerOutstandingTools(registry.server, deps);
  registerGstTools(registry.server, deps);
  registerSearchTools(registry.server, deps);
  registerLedgerTransactionTools(registry.server, deps);
  registerPartyStatementTools(registry.server, deps);
  registerTieOutTools(registry.server, deps);
  registerMaterialityTools(registry.server, deps);

  return registry;
}

function serveDefaults(): void {
  mock.onBodyContaining('List of Companies', { body: fixture('company-list.xml') });
  mock.onBodyContaining('<ID>Ledgers</ID>', { body: fixture('ledger-list.xml') });
  mock.onBodyContaining('<FETCH>*</FETCH>', { body: fixture('ledger-list-allfields.xml') });
  mock.onBodyContaining('<ID>Groups</ID>', { body: GROUP_LIST_XML });
  mock.onBodyContaining('<ID>VoucherTypes</ID>', { body: fixture('voucher-types.xml') });
  mock.onBodyContaining('<ID>StockItems</ID>', { body: fixture('stock-items-populated.xml') });
  mock.onBodyContaining('<TYPE>Voucher</TYPE>', { body: fixture('day-book.xml') });
  mock.onBodyContaining('Trial Balance', { body: fixture('trial-balance.xml') });
  mock.onBodyContaining('Balance Sheet', { body: fixture('balance-sheet.xml') });
  mock.onBodyContaining('Profit and Loss', { body: fixture('profit-loss.xml') });
  mock.onBodyContaining('<ID>Cash Flow</ID>', { body: fixture('cash-flow.xml') });
  mock.onBodyContaining('<ID>Funds Flow</ID>', { body: fixture('funds-flow.xml') });
}

const GROUP_LIST_XML =
  '<ENVELOPE><BODY><DATA>' +
  '<GROUP>0</GROUP>' +
  '<GROUP NAME="Sundry Debtors"><PARENT>Current Assets</PARENT>' +
  '<ISREVENUE>No</ISREVENUE><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></GROUP>' +
  '</DATA></BODY></ENVELOPE>';

/**
 * Minimal valid arguments per tool, so every registered tool can be exercised
 * generically. Tools with required parameters are listed; the rest default.
 *
 * `tally_connection_status` is the one deliberate exemption: it answers "did
 * TallyPrime reply?" and returns no accounting data, so it has no company, no
 * rows and nothing to be truncated. Giving it an envelope would mean inventing
 * values for all four.
 */
const REQUIRED_ARGS: Record<string, Record<string, unknown>> = {
  tally_get_statement: { statement: 'trial_balance' },
  tally_get_outstanding: { side: 'receivable' },
  tally_get_gst: { view: 'summary' },
  tally_search: { query: 'a' },
  tally_get_party_statement: { query: 'Northwind' },
  tally_get_ledger_transactions: { name: 'Northwind Retail' },
  tally_calculate_materiality: { benchmark: 'revenue', amount: '12500000' },
};

const EXEMPT = new Set(['tally_connection_status']);

/**
 * Tools that compute from their arguments and read nothing from TallyPrime.
 *
 * They still carry the envelope — `truncated` and `row_count` are meaningful,
 * and consistency is the point — but `source_query` is legitimately empty,
 * because no request produced their figures.
 */
const COMPUTATION_ONLY = new Set(['tally_calculate_materiality']);

const ENVELOPE_FIELDS = [
  'data',
  'company_id',
  'as_of_timestamp',
  'data_fetched_at',
  'source_query',
  'row_count',
  'truncated',
] as const;

beforeAll(async () => {
  mock = new MockTallyServer();
  port = await mock.start();
});

afterAll(async () => {
  await mock.stop();
});

beforeEach(() => {
  mock.reset();
  serveDefaults();
});

/**
 * Every data tool, discovered from the registry rather than hand-listed.
 *
 * Evaluated at collection time to feed `it.each`, before the mock server has
 * a port — hence the placeholder. Registration only records handlers and
 * schemas; nothing is sent, so the port is never used.
 */
const DATA_TOOLS = [...buildOn(1).handlers.keys()].filter((name) => !EXEMPT.has(name));

describe('response envelope (spec §4)', () => {
  it('covers every registered tool but the connection probe', () => {
    // Guards the enumeration itself: if this drifts, the per-tool assertions
    // below could silently be covering nothing.
    expect(DATA_TOOLS).toHaveLength(15);
  });

  it.each(DATA_TOOLS)('%s returns all six envelope fields', async (name) => {
    const envelope = await callToolEnvelope(build(), name, REQUIRED_ARGS[name] ?? {});

    for (const field of ENVELOPE_FIELDS) {
      expect(envelope, `${name} is missing "${field}"`).toHaveProperty(field);
    }

    // Types matter as much as presence: `truncated: "no"` would satisfy a
    // presence check while defeating the rule it exists to enforce.
    expect(typeof envelope.truncated, `${name}.truncated`).toBe('boolean');
    expect(typeof envelope.row_count, `${name}.row_count`).toBe('number');
    expect(Array.isArray(envelope.source_query), `${name}.source_query`).toBe(true);
    expect(new Date(envelope.as_of_timestamp as string).getTime()).not.toBeNaN();
  });

  /**
   * The cache TTL is five minutes, so "when this answer was produced" and "when
   * this data was read from TallyPrime" are different moments. A workpaper figure
   * dated by the former while resting on the latter is a false provenance claim,
   * which is the whole reason data_fetched_at exists.
   */
  it.each(DATA_TOOLS)('%s dates its data, not just its answer', async (name) => {
    const registry = build();
    const envelope = await callToolEnvelope(registry, name, REQUIRED_ARGS[name] ?? {});
    const fetchedAt = envelope.data_fetched_at;

    if (COMPUTATION_ONLY.has(name)) {
      // Nothing was read from Tally, so there is no data to date. Null, never a
      // timestamp that would imply a fetch happened.
      expect(fetchedAt, `${name} read nothing but dated its data`).toBeNull();
      return;
    }

    expect(typeof fetchedAt, `${name}.data_fetched_at`).toBe('string');
    const fetched = new Date(fetchedAt as string).getTime();
    expect(fetched).not.toBeNaN();
    // Data cannot have been read after the answer was produced.
    expect(fetched).toBeLessThanOrEqual(
      new Date(envelope.as_of_timestamp as string).getTime()
    );
  });

  /**
   * The behaviour that makes the field worth having: a cached answer must be
   * dated by the ORIGINAL fetch, not by the moment it was served. Dating a hit
   * `now` would make stale data look current.
   */
  it('dates a cached answer by when the data was actually read', async () => {
    const registry = build();

    const first = await callToolEnvelope(registry, 'tally_get_ledgers');
    // Same request, so it is served from the client's cache rather than re-sent.
    const second = await callToolEnvelope(registry, 'tally_get_ledgers');

    expect(second.data_fetched_at).toBe(first.data_fetched_at);
    // The answer itself is newer than the data it rests on, which is the point.
    expect(new Date(second.as_of_timestamp as string).getTime()).toBeGreaterThanOrEqual(
      new Date(second.data_fetched_at as string).getTime()
    );
  });

  it.each(DATA_TOOLS)('%s records only queries it actually sent', async (name) => {
    const registry = build();
    const envelope = await callToolEnvelope(registry, name, REQUIRED_ARGS[name] ?? {});
    const queries = envelope.source_query as string[];

    // Every recorded query must be one the mock actually received — otherwise
    // provenance is decoration rather than something that can be replayed.
    const sent = new Set(mock.requests.map((request) => request.body));
    for (const query of queries) {
      expect(sent.has(query), `${name} recorded a query that was never sent`).toBe(true);
    }
  });

  it.each(DATA_TOOLS.filter((name) => !COMPUTATION_ONLY.has(name)))(
    '%s reports at least one query behind its figures',
    async (name) => {
      const envelope = await callToolEnvelope(build(), name, REQUIRED_ARGS[name] ?? {});
      expect((envelope.source_query as string[]).length).toBeGreaterThan(0);
    }
  );

  it('leaves source_query empty for a tool that computes rather than reads', async () => {
    // A calculator has no query behind its figures — its provenance is the
    // inputs and the workings, which it returns in `basis`. Asserting a
    // non-empty source_query here would push toward inventing one, which is
    // worse than an honestly empty list.
    const envelope = await callToolEnvelope(build(), 'tally_calculate_materiality', {
      benchmark: 'revenue',
      amount: '12500000',
    });

    expect(envelope.source_query).toEqual([]);
    expect((envelope.data as { basis: { workings: string[] } }).basis.workings.length)
      .toBeGreaterThan(0);
  });

  it.each(DATA_TOOLS)('%s names the company its figures belong to', async (name) => {
    const envelope = await callToolEnvelope(build(), name, REQUIRED_ARGS[name] ?? {});
    expect(envelope.company_id).toBe('EXAMPLE TRADING PRIVATE LIMITED');
  });

  it('does not force an envelope onto the connection probe', async () => {
    const payload = await callToolEnvelope(build(), 'tally_connection_status');

    expect(payload.connected).toBe(true);
    expect(payload).not.toHaveProperty('row_count');
  });
});

describe('truncation is signalled one way (spec §6 rule 4)', () => {
  it('flags a partial page from a paginated tool', async () => {
    const envelope = await callToolEnvelope(build(), 'tally_get_ledgers', {
      page: 1,
      pageSize: 2,
    });

    const data = envelope.data as { pagination: { hasMore: boolean; total: number } };
    expect(data.pagination.hasMore).toBe(true);
    expect(data.pagination.total).toBeGreaterThan(2);
    // The envelope agrees with the inner detail rather than restating it
    // independently — one flag, one meaning.
    expect(envelope.truncated).toBe(true);
    expect(envelope.row_count).toBe(2);
  });

  it('reports a complete page as not truncated', async () => {
    const envelope = await callToolEnvelope(build(), 'tally_get_ledgers', {
      page: 1,
      pageSize: 500,
    });

    expect(envelope.truncated).toBe(false);
  });

  it('flags a capped search even though only one entity type was capped', async () => {
    // tally_search caps per entity type. Ledgers overflow a limit of 1 while
    // the other lists do not, and the answer as a whole is still partial.
    const envelope = await callToolEnvelope(build(), 'tally_search', {
      query: 'a',
      limit: 1,
    });

    expect(envelope.truncated).toBe(true);
  });

  it('flags a party statement capped by ledgerLimit', async () => {
    const envelope = await callToolEnvelope(build(), 'tally_get_party_statement', {
      query: 'a',
      ledgerLimit: 1,
    });

    const data = envelope.data as { ledgersMatched: { total: number; truncated: boolean } };
    expect(data.ledgersMatched.total).toBeGreaterThan(1);
    expect(data.ledgersMatched.truncated).toBe(true);
    expect(envelope.truncated).toBe(true);
  });

  it('refuses rather than truncating when the record ceiling is breached', async () => {
    // A hard refusal is a stronger guarantee than a flag, so this path is
    // deliberately left as an error rather than folded into `truncated`.
    const error = await callToolError(build({ TALLY_MAX_RECORDS: '2' }), 'tally_get_ledgers');
    expect(error.code).toBe('RESULT_LIMIT_EXCEEDED');
  });
});

describe('failures carry provenance too', () => {
  it('reports the requests that were sent before the failure', async () => {
    const registry = build();
    const handler = registry.handlers.get('tally_get_ledgers');
    const output = await handler?.({ name: 'No Such Ledger' });
    const payload = JSON.parse(output?.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(output?.isError).toBe(true);
    expect(payload.error).toBeDefined();

    // The ledger fetch happened; the lookup within it is what failed. Seeing
    // that request is the difference between diagnosing "wrong name" and
    // "never asked".
    expect((payload.source_query as string[]).length).toBeGreaterThan(0);
    expect(payload.as_of_timestamp).toBeDefined();

    // No data and no row count: nothing was returned, and a row_count of 0
    // here would read as "asked, found nothing" rather than "failed".
    expect(payload).not.toHaveProperty('row_count');
    expect(payload).not.toHaveProperty('data');
  });
});
