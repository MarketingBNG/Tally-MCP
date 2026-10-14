import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildImportRequest, voucherCreateMessage } from '../../tally/requests/import.js';
import { companySchema } from '../../schemas/common.js';
import { fetchVouchers } from '../read/vouchers/fetch.js';
import { runTool, type ToolDeps } from '../shared/toolResult.js';
import { writeTargetCompany } from '../shared/writeInputs.js';
import {
  contentMatches,
  describeVoucher,
  findVoucherByMasterId,
  headerMismatches,
  missingBills,
  sameNumberElsewhere,
  validateVoucher,
  voucherContentShape,
} from '../shared/voucherWrites.js';
import { missingCostCentres } from '../shared/voucherLines.js';
import { previewResult, WRITE_NOTICE } from '../confirm/flow.js';

/**
 * tally_create_voucher — post a new accounting voucher of any type.
 */
export function registerCreateVoucherTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_create_voucher',
    {
      description:
        'Post a NEW voucher in TallyPrime: Journal, Payment, Receipt, Contra, Sales, Purchase, Credit ' +
        'Note, Debit Note, Delivery Note, Receipt Note or any custom type.\n\n' +
        'Two forms: ACCOUNTING (ledger lines only) or ITEM INVOICE (give `items`: stock item, ' +
        'quantity, rate and the sales/purchase ledger, plus the party and any tax ledgers as ' +
        '`entries`). Any ledger line or item line can be split across cost centres. For stock ' +
        'transfers or production use tally_create_stock_journal.\n\n' +
        'WHEN TO USE: audit adjustments, provisions, reclassifications, recording a payment, receipt, ' +
        'sale or purchase.\n\n' +
        'Each line is a ledger, a side (Dr/Cr) and a positive amount. Debits must equal credits ' +
        'exactly. Party lines can carry bill-wise allocations (New Ref for an invoice, Agst Ref to ' +
        'settle one). GST/TDS are posted as ordinary ledger lines to the tax ledgers, with the ' +
        'amounts you give: nothing calculates tax for you.\n\n' +
        'REFUSES: an unbalanced voucher, an unknown ledger or voucher type, a date before the books ' +
        'begin. The preview warns about likely duplicates already in the books.\n\n' +
        WRITE_NOTICE,
      inputSchema: z.object({ company: companySchema, ...voucherContentShape }),
    },
    async (input) =>
      runTool('tally_create_voucher', deps, async () => {
        const company = await writeTargetCompany(deps, input.company);
        const validated = await validateVoucher(deps, company, input);
        const { content } = validated;

        const lookalikes = await possibleDuplicates(deps, company, content.date, validated);

        return previewResult(deps, {
          tool: 'tally_create_voucher',
          company,
          summary:
            `Post a ${content.voucherType} voucher dated ${content.date} for ${validated.total}` +
            (content.narration === undefined ? '.' : ` — "${content.narration}".`),
          preview: {
            action: 'CREATE VOUCHER',
            voucherType: content.voucherType,
            date: content.date,
            voucherNumber: content.voucherNumber ?? '(TallyPrime numbers it)',
            ...(content.reference === undefined ? {} : { reference: content.reference }),
            ...(content.partyLedger === undefined ? {} : { party: content.partyLedger }),
            narration: content.narration ?? '',
            lines: validated.table,
            ...(validated.itemTable.length > 0 ? { items: validated.itemTable } : {}),
            totalDebit: validated.total,
            totalCredit: validated.total,
            ...(validated.warnings.length + lookalikes.length > 0
              ? { warnings: [...validated.warnings, ...lookalikes] }
              : {}),
          },
          body: buildImportRequest('Vouchers', company, [voucherCreateMessage(content)]),
          expect: { created: 1 },
          // Nothing to re-check: a new voucher conflicts with nothing. Duplicates
          // are a judgement for the accountant, surfaced in the preview.
          recheck: () => Promise.resolve(),
          verify: async (d, counters) => {
            const masterId = counters?.lastVoucherId ?? 0;
            if (masterId <= 0) {
              return { confirmed: false, detail: 'TallyPrime did not report the new voucher\'s MasterId.' };
            }
            const made = await findVoucherByMasterId(d, company, masterId, content.date);
            if (made === null) {
              return { confirmed: false, detail: `voucher MasterId ${String(masterId)} was not found on ${content.date}` };
            }
            const billsMissing = missingBills(made, content.lines);
            const headerProblems = headerMismatches(made, content);
            const centresMissing = missingCostCentres(made, content);
            const numberNote = await sameNumberElsewhere(d, company, made);
            return {
              confirmed:
                contentMatches(made, content) &&
                made.voucherType === content.voucherType &&
                billsMissing.length === 0 &&
                centresMissing.length === 0 &&
                headerProblems.length === 0,
              detail: {
                guid: made.guid,
                masterId,
                ...describeVoucher(made),
                ...(billsMissing.length > 0 ? { billsNotFound: billsMissing } : {}),
                ...(centresMissing.length > 0 ? { costCentresNotFound: centresMissing } : {}),
                ...(headerProblems.length > 0 ? { headerNotStored: headerProblems } : {}),
                ...(numberNote === null ? {} : { numberingWarning: numberNote }),
              },
            };
          },
          undo:
            'Cancel it with tally_cancel_voucher (keeps the number, voids the entries) or remove it ' +
            'with tally_delete_voucher, using the guid and date in the read-back.',
        });
      })
  );
}

/**
 * Vouchers already in the books on the same date, of the same type, for the
 * same total — the shape of a double posting. Warned about, never blocked: two
 * identical rent payments in a day can be perfectly real.
 */
async function possibleDuplicates(
  deps: ToolDeps,
  company: string,
  date: string,
  validated: Awaited<ReturnType<typeof validateVoucher>>
): Promise<string[]> {
  try {
    const { vouchers } = await fetchVouchers(deps, company, { fromDate: date, toDate: date }, true, true);
    const same = vouchers.filter(
      (v) => !v.isCancelled && v.voucherType === validated.content.voucherType && contentMatches(v, validated.content)
    );
    return same.map(
      (v) =>
        `POSSIBLE DUPLICATE: ${String(v.voucherType)} ${String(v.voucherNumber)} on ${String(v.date)} ` +
        'already has exactly these lines. Confirm only if a second, separate entry is intended.'
    );
  } catch {
    return ['The duplicate check could not read the existing vouchers for that date.'];
  }
}
