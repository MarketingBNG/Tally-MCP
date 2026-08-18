import { describe, it, expect } from 'vitest';
import { normalizeVouchers } from '../../src/tally/normalize.js';

/**
 * A3: order and note vouchers were indistinguishable from real transactions.
 *
 * `IsOrderVoucher` and `IsInventoryVoucher` were neither requested nor parsed,
 * and `tally-database-loader` fetches both precisely so they can be kept out of
 * financial totals. The consequence was concentrated in inventory movements,
 * which excluded NOTHING — not even cancelled vouchers — while a sales ORDER
 * carries stock lines for goods that have not moved.
 *
 * Ledger-entry-based tools were already immune: an order voucher posts no ledger
 * entries, so it never reaches a bucket in `tally_summarise_movements` and has no
 * balancing obligation in `tally_check_tie_out`. That asymmetry is why the fix
 * belongs in the inventory path and the flags belong on the voucher.
 */

function voucherXml(
  attrs: { number: string; order?: boolean; inventory?: boolean; cancelled?: boolean } = {
    number: 'V-1',
  }
): string {
  return [
    '<VOUCHER>',
    '<DATE>20260715</DATE>',
    '<VOUCHERTYPENAME>Sales Order</VOUCHERTYPENAME>',
    `<VOUCHERNUMBER>${attrs.number}</VOUCHERNUMBER>`,
    `<ISCANCELLED>${attrs.cancelled === true ? 'Yes' : 'No'}</ISCANCELLED>`,
    '<ISOPTIONAL>No</ISOPTIONAL>',
    `<ISORDERVOUCHER>${attrs.order === true ? 'Yes' : 'No'}</ISORDERVOUCHER>`,
    `<ISINVENTORYVOUCHER>${attrs.inventory === true ? 'Yes' : 'No'}</ISINVENTORYVOUCHER>`,
    '</VOUCHER>',
  ].join('');
}

const envelope = (inner: string): string =>
  `<ENVELOPE><BODY><DATA><COLLECTION>${inner}</COLLECTION></DATA></BODY></ENVELOPE>`;

describe('order and stock-only voucher flags', () => {
  it('reads both flags when TallyPrime reports them', () => {
    const { data } = normalizeVouchers(
      envelope(voucherXml({ number: 'SO-1', order: true, inventory: true })),
      false,
      'INR',
      false
    );

    expect(data[0]?.isOrderVoucher).toBe(true);
    expect(data[0]?.isInventoryVoucher).toBe(true);
  });

  it('treats an absent flag as false rather than unknown', () => {
    // A company recording no orders or notes emits neither tag. Absence means
    // "not one of these", so false is the correct reading — not a null that every
    // caller would then have to interpret.
    const { data } = normalizeVouchers(
      envelope(
        '<VOUCHER><DATE>20260715</DATE><VOUCHERNUMBER>V-9</VOUCHERNUMBER></VOUCHER>'
      ),
      false,
      'INR',
      false
    );

    expect(data[0]?.isOrderVoucher).toBe(false);
    expect(data[0]?.isInventoryVoucher).toBe(false);
  });

  it('keeps the flags independent of the cancelled flag', () => {
    // A cancelled ORDER is both, and the inventory path excludes each for a
    // different stated reason, so conflating them would lose one of the counts.
    const { data } = normalizeVouchers(
      envelope(voucherXml({ number: 'SO-2', order: true, cancelled: true })),
      false,
      'INR',
      false
    );

    expect(data[0]?.isCancelled).toBe(true);
    expect(data[0]?.isOrderVoucher).toBe(true);
    expect(data[0]?.isInventoryVoucher).toBe(false);
  });

  it('distinguishes a real transaction from an order', () => {
    const { data } = normalizeVouchers(
      envelope(voucherXml({ number: 'INV-1' }) + voucherXml({ number: 'SO-3', order: true })),
      false,
      'INR',
      false
    );

    expect(data.map((v) => [v.voucherNumber, v.isOrderVoucher])).toEqual([
      ['INV-1', false],
      ['SO-3', true],
    ]);
  });
});

describe('the voucher request asks for the flags', () => {
  it('names both flags in the fetch list', async () => {
    // The parse above is useless if the request never asks. Tally sends the field
    // superset anyway, so adding them costs nothing — but they must be named.
    const { buildVoucherCollectionRequest, UNSCOPED } = await import('../../src/tally/requests.js');
    const body = buildVoucherCollectionRequest({
      company: UNSCOPED,
      fromDate: '2026-04-01',
      toDate: '2026-07-31',
    });

    expect(body).toContain('IsOrderVoucher');
    expect(body).toContain('IsInventoryVoucher');
  });
});
