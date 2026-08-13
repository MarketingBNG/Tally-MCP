import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callTool,
  callToolError,
  callToolOk,
  createToolRegistry,
  fixture,
  makeDeps,
  type ToolRegistry,
} from './harness.js';
import { registerLedgerTools } from '../../src/tools/ledgers.js';
import { registerVoucherTools } from '../../src/tools/vouchers.js';
import { serializeToolPayload } from '../../src/tools/toolResult.js';
import { FIELD_HEAVY_PAGE_SIZE } from '../../src/utils/pagination.js';

/**
 * Response-size guards.
 *
 * MCP clients cap the size of a tool result — Claude Desktop rejects anything
 * over 1MB with "Tool result is too large" and discards it, so Claude never
 * sees the data and the user gets a failure with nothing actionable in it. The
 * record-count guard cannot prevent that: it counts records, and a page of 100
 * full-field vouchers is ~1.7MB at ~2% of the record ceiling.
 *
 * These tests pin the byte guard, the advice it derives, and the smaller
 * default page size for field-heavy fetches.
 */

let mock: MockTallyServer;
let port: number;

function build(overrides: Record<string, string> = {}): ToolRegistry {
  const registry = createToolRegistry();
  const deps = makeDeps(port, overrides);
  registerLedgerTools(registry.server, deps);
  registerVoucherTools(registry.server, deps);
  return registry;
}

beforeAll(async () => {
  mock = new MockTallyServer();
  port = await mock.start();
});

afterAll(async () => {
  await mock.stop();
});

/**
 * A ledger collection of `count` records, in the real wire shape.
 *
 * Built rather than fixtured because the committed fixtures are deliberately
 * small, and the failure under test only appears at volume — which is the whole
 * problem: the record-count guard passes and the client rejects the result.
 */
function largeLedgerList(count: number, namePrefix = ''): string {
  const ledgers = Array.from({ length: count }, (_, i) => {
    const name = `${namePrefix}Sundry Debtor Number ${String(i).padStart(4, '0')} Private Limited`;
    return (
      `<LEDGER NAME="${name}" RESERVEDNAME="">` +
      `<PARENT TYPE="String">Sundry Debtors</PARENT>` +
      `<CLOSINGBALANCE TYPE="Amount">-${String(100000 + i)}.00</CLOSINGBALANCE>` +
      `<OPENINGBALANCE TYPE="Amount">0.00</OPENINGBALANCE>` +
      `<PARTYGSTIN TYPE="String">29AABCU9603R1Z${String(i % 10)}</PARTYGSTIN>` +
      `</LEDGER>`
    );
  }).join('');

  return `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION>${ledgers}</COLLECTION></DATA></BODY></ENVELOPE>`;
}

beforeEach(() => {
  mock.reset();
  mock.onBodyContaining('List of Companies', { body: fixture('company-list.xml') });
  mock.onBodyContaining('<ID>Ledgers</ID>', { body: fixture('ledger-list.xml') });
  mock.onBodyContaining('<FETCH>*</FETCH>', { body: fixture('ledger-list-allfields.xml') });
  mock.onBodyContaining('<TYPE>Voucher</TYPE>', { body: fixture('day-book.xml') });
});

describe('serializeToolPayload', () => {
  it('emits compact JSON, since indentation is bytes spent on nothing', () => {
    const text = serializeToolPayload({ items: [{ name: 'Acme', parent: 'Sundry Debtors' }] });

    expect(text).not.toContain('\n');
    expect(text).not.toContain('  ');
    // Still valid JSON — the model parses it identically either way.
    expect(JSON.parse(text)).toEqual({ items: [{ name: 'Acme', parent: 'Sundry Debtors' }] });
  });
});

describe('the response byte ceiling', () => {
  /** 500 ledgers serialises to well over the 10000-byte ceiling used here. */
  function oversized(): ToolRegistry {
    mock.onBodyContaining('<ID>Ledgers</ID>', { body: largeLedgerList(500) });
    return build({ TALLY_MAX_RESPONSE_BYTES: '10000', TALLY_MAX_RECORDS: '5000' });
  }

  it('refuses a response above the ceiling instead of letting the client discard it', async () => {
    const error = await callToolError(oversized(), 'tally_get_ledgers', { pageSize: 500 });
    expect(error.code).toBe('RESPONSE_TOO_LARGE');
  });

  it('names a smaller pageSize, computed from the measured size', async () => {
    const error = await callToolError(oversized(), 'tally_get_ledgers', { pageSize: 500 });

    // The advice must be arithmetic on real bytes, not a fixed string: a
    // suggestion that fails again sends Claude bisecting.
    expect(error.suggestion).toMatch(/pageSize \d+ or lower/);
    expect(error.suggestion).toContain('pageSize 500');

    // And it must actually be smaller than what was tried.
    const suggested = Number(/pageSize (\d+) or lower/.exec(error.suggestion)?.[1]);
    expect(suggested).toBeGreaterThan(0);
    expect(suggested).toBeLessThan(500);
  });

  it('says the data was retrieved, so this is not read as a Tally failure', async () => {
    const error = await callToolError(oversized(), 'tally_get_ledgers', { pageSize: 500 });

    expect(error.message).toContain('retrieved successfully');
    // Distinct from the record-count guard, which has a different remedy.
    expect(error.code).not.toBe('RESULT_LIMIT_EXCEEDED');
  });

  it('the suggested pageSize actually succeeds', async () => {
    // The point of computing advice from a measurement rather than guessing:
    // one retry should work, not begin a search.
    const error = await callToolError(oversized(), 'tally_get_ledgers', { pageSize: 500 });
    const suggested = Number(/pageSize (\d+) or lower/.exec(error.suggestion)?.[1]);

    const result = await callToolOk(oversized(), 'tally_get_ledgers', { pageSize: suggested });
    expect((result.pagination as { pageSize: number }).pageSize).toBe(suggested);
  });

  it('lets an ordinary response through untouched', async () => {
    const result = await callToolOk(build(), 'tally_get_ledgers');
    expect(Array.isArray(result.items)).toBe(true);
  });

  it('counts UTF-8 bytes, not JavaScript string length', async () => {
    // The rupee sign is one character and three bytes. A `.length`-based guard
    // would under-count by up to 3x on exactly the data an Indian install
    // returns, passing a payload the client then discards.
    mock.onBodyContaining('<ID>Ledgers</ID>', { body: largeLedgerList(500, '₹ अदा करें ') });

    // Measure the real payload, then pit the two units against each other by
    // setting the ceiling between them.
    const ok = await callToolOk(build({ TALLY_MAX_RESPONSE_BYTES: '50000000' }), 'tally_get_ledgers', {
      pageSize: 500,
    });
    const text = serializeToolPayload(ok);
    const characters = text.length;
    const bytes = Buffer.byteLength(text, 'utf8');
    expect(bytes).toBeGreaterThan(characters);

    // A ceiling above the character count but below the byte count: correct
    // (byte) counting refuses this, character counting would allow it.
    mock.onBodyContaining('<ID>Ledgers</ID>', { body: largeLedgerList(500, '₹ अदा करें ') });
    const error = await callToolError(
      build({ TALLY_MAX_RESPONSE_BYTES: String(characters) }),
      'tally_get_ledgers',
      { pageSize: 500 }
    );
    expect(error.code).toBe('RESPONSE_TOO_LARGE');
  });

  it('still returns a structured error payload, never a stack trace', async () => {
    mock.onBodyContaining('<ID>Ledgers</ID>', { body: largeLedgerList(500) });
    const payload = (await callTool(
      build({ TALLY_MAX_RESPONSE_BYTES: '10000' }),
      'tally_get_ledgers',
      { pageSize: 500 }
    )) as { error?: { code: string } };

    expect(payload.error?.code).toBe('RESPONSE_TOO_LARGE');
    expect(JSON.stringify(payload)).not.toContain('at Object.');
  });
});

describe('page size defaults adapt to field-heavy requests', () => {
  it('defaults to the smaller page when includeAllFields is on', async () => {
    const result = await callToolOk(build(), 'tally_get_ledgers', { includeAllFields: true });
    const pagination = result.pagination as { pageSize: number };

    expect(pagination.pageSize).toBe(FIELD_HEAVY_PAGE_SIZE);
  });

  it('keeps the ordinary default when it is off', async () => {
    const result = await callToolOk(build(), 'tally_get_ledgers');
    expect((result.pagination as { pageSize: number }).pageSize).toBe(100);
  });

  it('honours an explicit pageSize rather than silently substituting one', async () => {
    // A caller who names a page size gets it, and the byte guard has the final
    // say — a silent substitution would make the response not match the request.
    const result = await callToolOk(build(), 'tally_get_ledgers', {
      includeAllFields: true,
      pageSize: 200,
    });

    expect((result.pagination as { pageSize: number }).pageSize).toBe(200);
  });

  it('applies the smaller default to voucher searches that need fields', async () => {
    // fieldMatch forces full-field parsing even when includeAllFields is off,
    // so the response is field-heavy either way.
    const result = await callToolOk(build(), 'tally_get_vouchers', {
      fieldMatch: '4471',
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });

    expect((result.pagination as { pageSize: number }).pageSize).toBe(FIELD_HEAVY_PAGE_SIZE);
  });
});
