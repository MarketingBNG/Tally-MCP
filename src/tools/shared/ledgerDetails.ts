import { buildLedgerListRequest } from '../../tally/requests.js';
import { attributesOf, childrenNamed, childText, findAll, textOf } from '../../tally/TallyResponseParser.js';
import { dataScope, openDocument } from '../../tally/normalize/shared.js';
import type { ToolDeps } from './toolResult.js';

/**
 * A ledger's party details exactly as TallyPrime holds them, for write previews
 * and read-backs.
 *
 * ## Why the address is not a plain field
 *
 * Verified live 2026-10-14: TallyPrime keeps mailing name, address, state,
 * country and pincode inside a dated `LEDMAILINGDETAILS.LIST` (one entry per
 * `APPLICABLEFROM` date), NOT in the top-level MAILINGNAME / ADDRESS.LIST /
 * LEDSTATENAME / COUNTRYNAME / PINCODE elements. Sending the top-level forms was
 * accepted with ALTERED 1 and silently stored NOTHING — which is why every
 * detail written is read back here rather than trusted.
 */
export interface MailingDetails {
  applicableFrom: string | null;
  mailingName: string | null;
  address: string[];
  state: string | null;
  country: string | null;
  pincode: string | null;
}

export interface LedgerDetails {
  name: string;
  email: string | null;
  incomeTaxNumber: string | null;
  gstin: string | null;
  isBillWiseOn: boolean;
  /** Every dated mailing block, oldest first. */
  mailing: MailingDetails[];
}

const empty = (value: string | null): string | null => (value === null || value.trim() === '' ? null : value);

/**
 * Read one ledger's details with a full-field fetch.
 *
 * Always XML, whatever the configured wire format: the nested mailing list is
 * read structurally here, and this is one request per write, so its size (the
 * whole ledger collection with every field) is an acceptable price for
 * certainty about what landed in the books.
 */
export async function readLedgerDetails(
  deps: ToolDeps,
  company: string,
  name: string
): Promise<LedgerDetails | null> {
  const response = await deps.client.send(buildLedgerListRequest({ company, format: 'xml' }, true), 'report');
  const wanted = name.trim().toLowerCase();
  const node = findAll(dataScope(openDocument(response.body)), 'LEDGER').find(
    (candidate) => (attributesOf(candidate).NAME ?? '').toLowerCase() === wanted
  );
  if (node === undefined) return null;

  const mailing = childrenNamed(node, 'LEDMAILINGDETAILS.LIST')
    .map((block) => ({
      applicableFrom: empty(childText(block, 'APPLICABLEFROM')),
      mailingName: empty(childText(block, 'MAILINGNAME')),
      address: childrenNamed(block, 'ADDRESS.LIST')
        .flatMap((list) => childrenNamed(list, 'ADDRESS'))
        .map((line) => textOf(line))
        .filter((line): line is string => line !== null && line.trim() !== ''),
      state: empty(childText(block, 'STATE')),
      country: empty(childText(block, 'COUNTRY')),
      pincode: empty(childText(block, 'PINCODE')),
    }))
    .filter((block) => block.applicableFrom !== null || block.mailingName !== null || block.address.length > 0)
    .sort((a, b) => (a.applicableFrom ?? '').localeCompare(b.applicableFrom ?? ''));

  return {
    name: attributesOf(node).NAME ?? name,
    email: empty(childText(node, 'EMAIL')),
    incomeTaxNumber: empty(childText(node, 'INCOMETAXNUMBER')),
    gstin: empty(childText(node, 'PARTYGSTIN')),
    isBillWiseOn: (childText(node, 'ISBILLWISEON') ?? '').toLowerCase() === 'yes',
    mailing,
  };
}

/** The party-detail inputs both ledger tools take. */
export interface DetailsInput {
  mailingName?: string | undefined;
  address?: string[] | undefined;
  state?: string | undefined;
  country?: string | undefined;
  pincode?: string | undefined;
  email?: string | undefined;
  incomeTaxNumber?: string | undefined;
  gstin?: string | undefined;
  isBillWiseOn?: boolean | undefined;
}

/** Party details to write, ready for the import and the preview. */
export interface PlannedDetails {
  email?: string;
  incomeTaxNumber?: string;
  gstin?: string;
  isBillWiseOn?: boolean;
  mailing?: {
    applicableFrom: string;
    mailingName: string | null;
    address: string[];
    state: string | null;
    country: string | null;
    pincode: string | null;
  };
}

const MAILING_KEYS = ['mailingName', 'address', 'state', 'country', 'pincode'] as const;

/** Tally's YYYYMMDD to ISO. */
function isoFrom(tallyDate: string): string {
  return `${tallyDate.slice(0, 4)}-${tallyDate.slice(4, 6)}-${tallyDate.slice(6, 8)}`;
}

/**
 * Plan the details write.
 *
 * The mailing block is always sent WHOLE: the given fields merged over the
 * ledger's current latest block (its current address), because TallyPrime
 * replaces the block it receives — sending only a new pincode would otherwise
 * blank the address. A ledger with no block gets one dated from the start of
 * the books.
 */
export function planDetails(
  input: DetailsInput,
  current: LedgerDetails | null,
  booksBegin: string
): PlannedDetails {
  const planned: PlannedDetails = {};
  if (input.email !== undefined) planned.email = input.email;
  if (input.incomeTaxNumber !== undefined) planned.incomeTaxNumber = input.incomeTaxNumber;
  if (input.gstin !== undefined) planned.gstin = input.gstin;
  if (input.isBillWiseOn !== undefined) planned.isBillWiseOn = input.isBillWiseOn;

  if (MAILING_KEYS.some((key) => input[key] !== undefined)) {
    const base = current?.mailing[current.mailing.length - 1];
    planned.mailing = {
      applicableFrom: base?.applicableFrom ? isoFrom(base.applicableFrom) : booksBegin,
      mailingName: input.mailingName ?? base?.mailingName ?? null,
      address: input.address ?? base?.address ?? [],
      state: input.state ?? base?.state ?? null,
      country: input.country ?? base?.country ?? null,
      pincode: input.pincode ?? base?.pincode ?? null,
    };
  }
  return planned;
}

/** The details as they are now, for an alter preview's "from" column. */
export function currentDetailsView(current: LedgerDetails | null): Record<string, unknown> {
  const base = current?.mailing[current.mailing.length - 1];
  return {
    email: current?.email ?? null,
    incomeTaxNumber: current?.incomeTaxNumber ?? null,
    gstin: current?.gstin ?? null,
    isBillWiseOn: current?.isBillWiseOn ?? false,
    mailingName: base?.mailingName ?? null,
    address: base?.address ?? [],
    state: base?.state ?? null,
    country: base?.country ?? null,
    pincode: base?.pincode ?? null,
  };
}

/**
 * What did not land: each planned detail compared with the ledger as read back.
 * Empty means every detail is in the books exactly as written.
 */
export function detailMismatches(planned: PlannedDetails, actual: LedgerDetails | null): string[] {
  if (actual === null) return ['the ledger could not be read back'];
  const problems: string[] = [];
  const check = (label: string, want: unknown, got: unknown): void => {
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      problems.push(`${label}: wanted ${JSON.stringify(want)}, found ${JSON.stringify(got)}`);
    }
  };
  if (planned.email !== undefined) check('email', planned.email || null, actual.email);
  if (planned.incomeTaxNumber !== undefined) check('incomeTaxNumber', planned.incomeTaxNumber || null, actual.incomeTaxNumber);
  if (planned.gstin !== undefined) check('gstin', planned.gstin || null, actual.gstin);
  if (planned.isBillWiseOn !== undefined) check('isBillWiseOn', planned.isBillWiseOn, actual.isBillWiseOn);
  if (planned.mailing !== undefined) {
    const want = planned.mailing;
    const block = actual.mailing.find((b) => b.applicableFrom === want.applicableFrom.replace(/-/g, ''));
    if (block === undefined) {
      problems.push(`no mailing details dated ${want.applicableFrom} were found`);
    } else {
      check('mailingName', want.mailingName || null, block.mailingName);
      check('address', want.address.filter((l) => l.trim() !== ''), block.address);
      check('state', want.state || null, block.state);
      check('country', want.country || null, block.country);
      check('pincode', want.pincode || null, block.pincode);
    }
  }
  return problems;
}
