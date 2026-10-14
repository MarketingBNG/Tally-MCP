import { escapeXml } from './envelope.js';

/**
 * Write request construction — the ONLY file in this server that may emit an
 * Import envelope.
 *
 * Everything else under `src/tally/requests/` is Export-only, and a test scans
 * the source tree to hold that line: a write verb anywhere but here fails the
 * build. Keeping every write in one file is what makes the write surface
 * auditable in a single read.
 *
 * Deliberately NOT re-exported from `src/tally/requests.ts`, so the read tools
 * and the scheduled export (`installer/scripts/export.mjs`) have no path to it.
 * Only the tools under `src/tools/{create,alter,cancel,delete}` import it.
 *
 * ## The envelope, as verified live
 *
 * Verified against TallyPrime on 2026-10-14 (Probotix test company):
 * `<TALLYREQUEST>Import Data</TALLYREQUEST>` with `REPORTNAME` "All Masters"
 * answers with a `<RESPONSE>` of counters — see `importResponse.ts`. Two facts
 * from that probe shape everything built on top of this file:
 *
 *   - `ACTION="Create"` on a name that ALREADY EXISTS does not fail. TallyPrime
 *     alters the existing master and reports `ALTERED 1, ERRORS 0`. So a create
 *     must check existence first and be judged by `CREATED`, never by ERRORS.
 *   - A bad reference (an unknown parent group) is reported as `EXCEPTIONS 1`
 *     plus a `<LINEERROR>`, with `ERRORS` still 0.
 *
 * ## Company scope is not optional
 *
 * `company` is a plain string here, never `UNSCOPED`: an import with no
 * `SVCURRENTCOMPANY` lands in whichever company TallyPrime has current, which
 * for a write is not a wrong answer but wrong BOOKS. Pass the name
 * `assertCompanyIsLoaded` returned.
 */

/** The request verb for every write. Kept here so the source scan has one place to allow it. */
export const IMPORT_VERB = 'Import Data' as const;

/** What Tally's import does to the object named in an element's ACTION attribute. */
export type ImportAction = 'Create' | 'Alter' | 'Delete' | 'Cancel';

/** Which import report the body is addressed to. Masters and vouchers use different ones. */
export type ImportReport = 'All Masters' | 'Vouchers';

/**
 * Wrap one or more TALLYMESSAGE payloads in the import envelope.
 *
 * `messages` is the already-built inner XML (from the builders below). It is
 * not escaped again here — every value inside it was escaped when built.
 */
export function buildImportRequest(
  report: ImportReport,
  company: string,
  messages: readonly string[]
): string {
  if (company.trim() === '') {
    throw new Error('An import was built with no company. Writes must always name their company.');
  }
  if (messages.length === 0) {
    throw new Error('An import was built with nothing to import.');
  }

  return [
    '<ENVELOPE>',
    '<HEADER>',
    `<TALLYREQUEST>${IMPORT_VERB}</TALLYREQUEST>`,
    '</HEADER>',
    '<BODY><IMPORTDATA>',
    '<REQUESTDESC>',
    `<REPORTNAME>${report}</REPORTNAME>`,
    `<STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY></STATICVARIABLES>`,
    '</REQUESTDESC>',
    '<REQUESTDATA>',
    ...messages.map((message) => `<TALLYMESSAGE xmlns:UDF="TallyUDF">${message}</TALLYMESSAGE>`),
    '</REQUESTDATA>',
    '</IMPORTDATA></BODY>',
    '</ENVELOPE>',
  ].join('');
}

/** A text element, or nothing when the value is absent. Empty string is sent, to clear a field. */
function element(tag: string, value: string | undefined): string {
  return value === undefined ? '' : `<${tag}>${escapeXml(value)}</${tag}>`;
}

function yesNo(tag: string, value: boolean | undefined): string {
  return value === undefined ? '' : `<${tag}>${value ? 'Yes' : 'No'}</${tag}>`;
}

/**
 * The fields a ledger can be created or altered with.
 *
 * Every field is optional on alter: an absent field is left as it is in Tally,
 * which is why nothing here has a default.
 */
export interface LedgerFields {
  /** The new name, on alter. On create the name is the element's NAME. */
  rename?: string;
  parent?: string;
  /**
   * Opening balance in TallyPrime's own sign: NEGATIVE is debit, positive is
   * credit — the same convention every read tool reports. Sent as a plain
   * decimal string so no float rounding reaches the books.
   */
  openingBalance?: string;
  isBillWiseOn?: boolean;
  /**
   * The dated mailing block: name for letters, address, state, country, pincode.
   * Sent whole — every field of the block, merged by the caller with what is
   * already there — because TallyPrime replaces the block it is given.
   */
  mailing?: MailingBlock;
  email?: string;
  /** Income-tax number (PAN in India). */
  incomeTaxNumber?: string;
  gstin?: string;
}

/**
 * A ledger's mailing details for one APPLICABLEFROM date.
 *
 * Verified live 2026-10-14: TallyPrime keeps these inside a dated
 * LEDMAILINGDETAILS.LIST. The top-level MAILINGNAME / ADDRESS.LIST /
 * LEDSTATENAME / COUNTRYNAME / PINCODE elements are accepted on import with
 * ALTERED 1 and silently store NOTHING, so they are never sent.
 */
export interface MailingBlock {
  /** ISO YYYY-MM-DD the block applies from. */
  applicableFrom: string;
  mailingName?: string | null;
  address?: readonly string[];
  state?: string | null;
  country?: string | null;
  pincode?: string | null;
}

function mailingBlock(block: MailingBlock): string {
  const text = (tag: string, value: string | null | undefined): string =>
    value === null || value === undefined ? '' : element(tag, value);
  const address =
    block.address === undefined || block.address.length === 0
      ? ''
      : `<ADDRESS.LIST TYPE="String">${block.address.map((line) => element('ADDRESS', line)).join('')}</ADDRESS.LIST>`;
  return (
    '<LEDMAILINGDETAILS.LIST>' +
    address +
    element('APPLICABLEFROM', block.applicableFrom.replace(/-/g, '')) +
    text('PINCODE', block.pincode) +
    text('MAILINGNAME', block.mailingName) +
    text('STATE', block.state) +
    text('COUNTRY', block.country) +
    '</LEDMAILINGDETAILS.LIST>'
  );
}

/**
 * One LEDGER element for an import.
 *
 * `name` is the ledger as it is (or will be) in TallyPrime. On a rename, NAME
 * stays the CURRENT name and the new one goes in NAME.LIST — that is how Tally
 * identifies which ledger an alter is aimed at.
 */
export function ledgerMessage(action: ImportAction, name: string, fields: LedgerFields = {}): string {
  if (action === 'Delete') {
    return `<LEDGER NAME="${escapeXml(name)}" ACTION="Delete"><NAME.LIST><NAME>${escapeXml(name)}</NAME></NAME.LIST></LEDGER>`;
  }

  const listedName = fields.rename ?? name;

  return [
    `<LEDGER NAME="${escapeXml(name)}" ACTION="${action}">`,
    `<NAME.LIST TYPE="String"><NAME>${escapeXml(listedName)}</NAME></NAME.LIST>`,
    element('PARENT', fields.parent),
    element('OPENINGBALANCE', fields.openingBalance),
    yesNo('ISBILLWISEON', fields.isBillWiseOn),
    fields.mailing === undefined ? '' : mailingBlock(fields.mailing),
    element('EMAIL', fields.email),
    element('INCOMETAXNUMBER', fields.incomeTaxNumber),
    element('PARTYGSTIN', fields.gstin),
    '</LEDGER>',
  ].join('');
}

/**
 * The other masters this server writes, by TallyPrime's own element name.
 *
 * Each was created, read back and deleted live on 2026-10-14 before being
 * listed here. A tag not on this list is never sent — the same closed-list rule
 * the read side follows for collection types.
 */
export const MASTER_TAGS = ['GROUP', 'COSTCENTRE', 'UNIT', 'STOCKGROUP', 'GODOWN', 'STOCKITEM'] as const;
export type MasterTag = (typeof MASTER_TAGS)[number];

/** Fields across those masters. Each kind uses only its own; see the tools' kind table. */
export interface MasterFields {
  rename?: string;
  /** Parent group / cost centre / stock group / godown. Empty string = top level. */
  parent?: string;
  /** Cost centre category. */
  category?: string;
  /** Unit: its full name, e.g. "Kilograms" for "kg". */
  formalName?: string;
  /** Unit: decimal places quantities are kept to. */
  decimalPlaces?: number;
  /** Stock item: base unit symbol. */
  baseUnits?: string;
  /** Stock item opening quantity, e.g. "5 kg" (number and unit). */
  openingQuantity?: string;
  /** Stock item opening rate per unit, e.g. "10/kg". */
  openingRate?: string;
  /** Stock item opening value in TallyPrime's sign (stock in hand is NEGATIVE, a debit). */
  openingValue?: string;
}

/**
 * One master element for an import.
 *
 * A unit is named by its symbol in a plain NAME element (verified live); every
 * other master carries its name in NAME.LIST. NAME the attribute is always the
 * CURRENT name — that is how an alter finds its target.
 */
export function masterMessage(
  tag: MasterTag,
  action: ImportAction,
  name: string,
  fields: MasterFields = {}
): string {
  const open = `<${tag} NAME="${escapeXml(name)}" ACTION="${action}">`;
  const close = `</${tag}>`;
  if (action === 'Delete') {
    return `${open}<NAME.LIST><NAME>${escapeXml(name)}</NAME></NAME.LIST>${close}`;
  }

  const listedName = fields.rename ?? name;
  const nameElement =
    tag === 'UNIT'
      ? element('NAME', listedName)
      : `<NAME.LIST TYPE="String"><NAME>${escapeXml(listedName)}</NAME></NAME.LIST>`;

  return [
    open,
    nameElement,
    tag === 'UNIT' && action === 'Create' ? '<ISSIMPLEUNIT>Yes</ISSIMPLEUNIT>' : '',
    element('PARENT', fields.parent),
    element('CATEGORY', fields.category),
    element('ORIGINALNAME', fields.formalName),
    fields.decimalPlaces === undefined ? '' : `<DECIMALPLACES>${String(fields.decimalPlaces)}</DECIMALPLACES>`,
    element('BASEUNITS', fields.baseUnits),
    element('OPENINGBALANCE', fields.openingQuantity),
    element('OPENINGRATE', fields.openingRate),
    element('OPENINGVALUE', fields.openingValue),
    close,
  ].join('');
}

/**
 * One bill-wise allocation on a party line: which invoice a payment settles, or
 * the new invoice a sale raises. Amount in TallyPrime's sign, like the line's.
 */
export interface BillAllocation {
  /** "New Ref" raises a bill, "Agst Ref" settles one, "Advance", "On Account". */
  type: 'New Ref' | 'Agst Ref' | 'Advance' | 'On Account';
  /** The bill reference, e.g. the invoice number. Not used for On Account. */
  name?: string;
  amount: string;
}

/** One ledger line of a voucher. */
export interface VoucherLine {
  ledger: string;
  /** TallyPrime's sign: NEGATIVE is debit. */
  amount: string;
  bills?: readonly BillAllocation[];
}

/** The content of a voucher, for create and alter. */
export interface VoucherContent {
  voucherType: string;
  /** ISO YYYY-MM-DD; converted here. */
  date: string;
  voucherNumber?: string;
  reference?: string;
  narration?: string;
  partyLedger?: string;
  lines: readonly VoucherLine[];
}

/** ISO YYYY-MM-DD to Tally's YYYYMMDD. Kept local so this file needs nothing from the read side. */
function tallyDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error(`Not an ISO date: ${iso}`);
  return iso.replace(/-/g, '');
}

function isDebit(amount: string): boolean {
  return amount.trim().startsWith('-');
}

function voucherBody(content: VoucherContent): string {
  const lines = content.lines
    .map((line) => {
      const bills = (line.bills ?? [])
        .map(
          (bill) =>
            '<BILLALLOCATIONS.LIST>' +
            element('NAME', bill.name) +
            element('BILLTYPE', bill.type) +
            element('AMOUNT', bill.amount) +
            '</BILLALLOCATIONS.LIST>'
        )
        .join('');
      return (
        '<ALLLEDGERENTRIES.LIST>' +
        element('LEDGERNAME', line.ledger) +
        yesNo('ISDEEMEDPOSITIVE', isDebit(line.amount)) +
        element('AMOUNT', line.amount) +
        bills +
        '</ALLLEDGERENTRIES.LIST>'
      );
    })
    .join('');

  return (
    element('DATE', tallyDate(content.date)) +
    element('VOUCHERTYPENAME', content.voucherType) +
    element('VOUCHERNUMBER', content.voucherNumber) +
    element('REFERENCE', content.reference) +
    element('PARTYLEDGERNAME', content.partyLedger) +
    element('NARRATION', content.narration) +
    '<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>' +
    lines
  );
}

/**
 * A new voucher. Verified live: CREATED 1, and LASTVCHID carries its MasterId.
 */
export function voucherCreateMessage(content: VoucherContent): string {
  return (
    `<VOUCHER VCHTYPE="${escapeXml(content.voucherType)}" ACTION="Create" OBJVIEW="Accounting Voucher View">` +
    voucherBody(content) +
    '</VOUCHER>'
  );
}

/**
 * The attributes that aim an import at ONE existing voucher.
 *
 * By MasterID, which is the only targeting verified to hit exactly the voucher
 * meant. Verified live 2026-10-14 that the obvious alternative is dangerous:
 * `REMOTEID="<guid>"` with ACTION="Alter" did not alter anything — TallyPrime
 * CREATED a second voucher. So did a MasterID that no longer exists. Callers
 * must therefore re-check the target exists immediately before sending, and
 * judge the reply on exact counters.
 */
function targetAttributes(masterId: number, date: string, voucherType: string): string {
  if (!Number.isInteger(masterId) || masterId <= 0) throw new Error(`Not a MasterId: ${String(masterId)}`);
  return (
    `DATE="${tallyDate(date)}" TAGNAME="MasterID" TAGVALUE="${String(masterId)}" ` +
    `VCHTYPE="${escapeXml(voucherType)}"`
  );
}

/** Replace an existing voucher's content. Verified live: ALTERED 1, entries replaced, not appended. */
export function voucherAlterMessage(masterId: number, currentDate: string, content: VoucherContent): string {
  return (
    `<VOUCHER ${targetAttributes(masterId, currentDate, content.voucherType)} ACTION="Alter" OBJVIEW="Accounting Voucher View">` +
    voucherBody(content) +
    '</VOUCHER>'
  );
}

/**
 * Cancel an existing voucher: it keeps its number, its entries are cleared.
 * Verified live: TallyPrime reports this as ALTERED 1, not CANCELLED.
 */
export function voucherCancelMessage(
  masterId: number,
  date: string,
  voucherType: string,
  narration?: string
): string {
  return (
    `<VOUCHER ${targetAttributes(masterId, date, voucherType)} ACTION="Cancel">` +
    element('NARRATION', narration) +
    '</VOUCHER>'
  );
}

/** Delete an existing voucher. Verified live: DELETED 1; an unknown MasterID is refused. */
export function voucherDeleteMessage(masterId: number, date: string, voucherType: string): string {
  return `<VOUCHER ${targetAttributes(masterId, date, voucherType)} ACTION="Delete"></VOUCHER>`;
}
