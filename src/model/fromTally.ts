import { Decimal } from 'decimal.js';
import type {
  Company as TallyCompany,
  Group as TallyGroup,
  Ledger as TallyLedger,
  Voucher as TallyVoucher,
} from '../tally/normalize.js';
import { DEFAULT_CURRENCY, type Money } from '../utils/numbers.js';
import type {
  Account,
  AccountType,
  Entity,
  EntryLine,
  SignedAmount,
  SourceRef,
  Voucher,
  VoucherFamily,
} from './ledger.js';

/**
 * The TallyPrime adapter: Tally's shapes into the normalised ledger model.
 *
 * This is the first of what Annexure A §3 expects to be several — Zoho Books
 * and QuickBooks Online adapters follow the same contract. Everything
 * downstream (audit tests, reports, the GAAP bridge) is written once against
 * the model and never sees anything in this file.
 *
 * It converts what `src/tally/normalize.ts` has already parsed rather than
 * touching XML. That separation is deliberate: normalize.ts is proven against
 * live Tally data and knows Tally's wire quirks, and this layer only has to
 * know Tally's *accounting* conventions. Two smaller jobs, each testable.
 *
 * WARNINGS, NOT EXCEPTIONS. Every function here returns warnings alongside its
 * data. An adapter that throws on the first oddity is useless for audit work,
 * where oddities are the point — a ledger with no balance, an entry whose sign
 * contradicts its own debit flag. Those are findings, and they must survive
 * into the output rather than aborting it.
 */

export interface Adapted<T> {
  data: T;
  warnings: string[];
}

/**
 * How Tally's signed amounts are carried into the model.
 *
 * THE PENDING DECISION, in one switch. docs/normalised-ledger-model.md puts it
 * to the audit-team domain owner, and Annexure A §7.3 requires an answer
 * before a second adapter is written.
 *
 * - `side_and_magnitude` (default, and the recommendation): a positive
 *   magnitude plus an explicit debit/credit label. Comparable across sources,
 *   because QuickBooks and Zoho Books do not share Tally's sign convention.
 * - `preserve_source_sign`: Tally's own encoding, where a debit is negative.
 *   Matches the Tally screen character for character, and stops working the
 *   moment a second source appears.
 *
 * It is a switch rather than a hard-coded choice so the decision can be
 * reversed by changing one argument instead of rewriting the adapter — but it
 * is NOT meant to stay configurable. Once the domain owner rules, the loser
 * should be deleted: two conventions live in the same system is worse than
 * either one of them.
 */
export type SignConvention = 'side_and_magnitude' | 'preserve_source_sign';

export interface AdapterOptions {
  entityId: string;
  signConvention?: SignConvention;
}

function ref(entityType: SourceRef['entityType'], identifier: string, query?: string): SourceRef {
  return {
    system: 'tallyprime',
    entityType,
    identifier,
    ...(query === undefined ? {} : { sourceQuery: query }),
  };
}

/**
 * Translate a Tally provenance reference into the model's.
 *
 * The two carry the same identifier but name entity kinds differently — Tally
 * has "company", "ledger" and "group"; the model has "entity" and "account",
 * because that is the vocabulary a QuickBooks or Zoho adapter can also use.
 * Passing Tally's through unchanged would leak Tally's vocabulary into every
 * record in the model, which is exactly what Annexure A §3.3 rules out.
 */
function adaptSource(
  source: { entityType: string; identifier: string },
  entityType: SourceRef['entityType']
): SourceRef {
  return ref(entityType, source.identifier);
}

// ---------------------------------------------------------------------------
// Amounts and the sign decision
// ---------------------------------------------------------------------------

/**
 * Convert a Tally-signed balance into the model's side-plus-magnitude form.
 *
 * Tally encodes a DEBIT balance as a negative number — documented on
 * `Ledger.openingBalance` in normalize.ts and confirmed against live data.
 * Zero is treated as a credit rather than being rejected: a nil balance is a
 * real state, and it has to land on one side to be representable at all. It is
 * flagged so nobody reads a nil credit as a positive assertion.
 */
export function toSignedAmount(
  money: Money | null,
  label: string,
  warnings: string[],
  convention: SignConvention = 'side_and_magnitude'
): SignedAmount | null {
  if (money === null) return null;

  const value = new Decimal(money.amount);

  if (convention === 'preserve_source_sign') {
    return {
      magnitude: money,
      side: value.isNegative() ? 'debit' : 'credit',
    };
  }

  if (value.isZero()) {
    warnings.push(
      `${label} is nil. A nil balance has no natural side, so it is reported as a zero credit; do not read the side as meaningful.`
    );
  }

  return {
    magnitude: { amount: value.abs().toFixed(), currency: money.currency },
    side: value.isNegative() ? 'debit' : 'credit',
  };
}

/**
 * Convert an entry amount, where Tally supplies the side independently.
 *
 * The side comes from Tally's own ISDEEMEDPOSITIVE flag, which normalize.ts
 * already reads, rather than from the sign — the flag is what Tally treats as
 * authoritative. The two agree in all data observed so far, so a DISAGREEMENT
 * is worth surfacing: it means either an assumption here is wrong or the
 * record itself is odd, and both are things an auditor should be told rather
 * than have silently resolved.
 */
function entryAmount(
  money: Money | null,
  side: 'debit' | 'credit',
  label: string,
  warnings: string[],
  convention: SignConvention
): SignedAmount | null {
  if (money === null) return null;

  const value = new Decimal(money.amount);

  if (!value.isZero()) {
    const impliedSide = value.isNegative() ? 'debit' : 'credit';
    if (impliedSide !== side) {
      warnings.push(
        `${label}: TallyPrime's debit flag says "${side}" but the amount's sign implies "${impliedSide}". The flag is treated as authoritative. Worth checking the voucher.`
      );
    }
  }

  if (convention === 'preserve_source_sign') {
    return { magnitude: money, side };
  }

  return {
    magnitude: { amount: value.abs().toFixed(), currency: money.currency },
    side,
  };
}

// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------

export function adaptCompany(company: TallyCompany, options: AdapterOptions): Entity {
  return {
    id: options.entityId,
    name: company.name,
    // TallyPrime does not report the books' currency over this interface, and
    // every install observed has been INR. Assumed rather than read, which is
    // safe today and must be revisited for the first non-INR entity.
    functionalCurrency: DEFAULT_CURRENCY,
    fiscalYearStartMonth:
      company.startingFrom === null ? null : Number(company.startingFrom.slice(5, 7)),
    // Not derivable from Tally. Belongs in the client registry (Spec §4 L0),
    // which is partner-owned configuration rather than anything in the books.
    framework: null,
    taxIdentifiers: [],
    source: ref('entity', company.name),
  };
}

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------

/**
 * Classify a group from Tally's two boolean flags.
 *
 * `isRevenue` separates the P&L from the balance sheet; `isDeemedPositive` is
 * Tally's debit-nature flag. Together they give four of the model's five
 * account types.
 *
 * EQUITY IS NOT DERIVABLE and is never returned here. Tally files capital
 * accounts under a liability-natured primary group, so its flags cannot
 * distinguish share capital from a trade payable. Separating them is a mapping
 * decision, and Spec §4 L2 is explicit that the ledger mapping table is
 * "professional-judgement content owned by the engagement team, not IT".
 * Guessing at it here would put an unreviewed judgement underneath every
 * balance sheet the system produces.
 */
export function classifyGroup(group: TallyGroup): AccountType {
  if (group.isRevenue) return group.isDeemedPositive ? 'expense' : 'income';
  return group.isDeemedPositive ? 'asset' : 'liability';
}

/**
 * Build the account tree from Tally's groups and ledgers.
 *
 * Groups become non-postable nodes, ledgers become postable leaves under their
 * parent group — one tree, as QuickBooks and Zoho Books model it, rather than
 * Tally's two entity types. A test that walks the chart of accounts then reads
 * the same on every source.
 */
export function adaptAccounts(
  groups: readonly TallyGroup[],
  ledgers: readonly TallyLedger[],
  options: AdapterOptions
): Adapted<Account[]> {
  const warnings: string[] = [];
  const convention = options.signConvention ?? 'side_and_magnitude';

  const byName = new Map(groups.map((group) => [group.name.toLowerCase(), group]));

  /** Root-to-leaf names. Cycles are defended against, not assumed absent. */
  const pathOf = (startName: string, startParent: string | null): string[] => {
    const path = [startName];
    const seen = new Set([startName.toLowerCase()]);
    let parent = startParent;

    while (parent !== null && parent !== '') {
      const key = parent.toLowerCase();
      if (seen.has(key)) {
        warnings.push(
          `The account hierarchy above "${startName}" loops back on itself at "${parent}". The path is reported as far as the loop.`
        );
        break;
      }
      seen.add(key);
      path.unshift(parent);
      parent = byName.get(key)?.parent ?? null;
    }

    return path;
  };

  /** Walk up to the nearest group that carries a classification. */
  const typeOf = (parentName: string | null, label: string): AccountType => {
    let current = parentName;
    const seen = new Set<string>();

    while (current !== null && current !== '') {
      const key = current.toLowerCase();
      if (seen.has(key)) break;
      seen.add(key);

      const group = byName.get(key);
      if (group === undefined) break;
      if (group.parent === null || group.parent === '') return classifyGroup(group);
      current = group.parent;
    }

    const group = parentName === null ? undefined : byName.get(parentName.toLowerCase());
    if (group !== undefined) return classifyGroup(group);

    warnings.push(
      `${label} sits under "${parentName ?? '(no parent)'}", which is not in the group list, so its classification could not be derived. Reported as an asset; treat it as unclassified.`
    );
    return 'asset';
  };

  const accounts: Account[] = groups.map((group) => ({
    id: group.name,
    entityId: options.entityId,
    code: null,
    name: group.name,
    parentId: group.parent === '' ? null : group.parent,
    path: pathOf(group.name, group.parent),
    type: classifyGroup(group),
    normalBalance: group.isDeemedPositive ? 'debit' : 'credit',
    isPostable: false,
    openingBalance: null,
    closingBalance: null,
    source: adaptSource(group.source, 'account'),
  }));

  for (const ledger of ledgers) {
    const type = typeOf(ledger.parent, `Ledger "${ledger.name}"`);
    accounts.push({
      id: ledger.name,
      entityId: options.entityId,
      code: null,
      name: ledger.name,
      parentId: ledger.parent,
      path: pathOf(ledger.name, ledger.parent),
      type,
      normalBalance: type === 'asset' || type === 'expense' ? 'debit' : 'credit',
      isPostable: true,
      openingBalance: toSignedAmount(
        ledger.openingBalance,
        `Opening balance of "${ledger.name}"`,
        warnings,
        convention
      ),
      closingBalance: toSignedAmount(
        ledger.closingBalance,
        `Closing balance of "${ledger.name}"`,
        warnings,
        convention
      ),
      source: adaptSource(ledger.source, 'account'),
      ...(ledger.fields === undefined ? {} : { raw: ledger.fields }),
    });
  }

  return { data: accounts, warnings };
}

// ---------------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------------

/**
 * Map a Tally voucher type onto the model's transaction families.
 *
 * Matched against the type's PARENT, which is the built-in type it derives
 * from, never its name. A company's custom "Tax Invoice" carries neither
 * "sales" nor anything else useful in its name, and matching on names would
 * silently drop it from every sales test. The existing voucher tools already
 * resolve families this way.
 */
export function classifyVoucherFamily(baseType: string | null): VoucherFamily {
  switch ((baseType ?? '').trim().toLowerCase()) {
    case 'sales':
      return 'sales';
    case 'purchase':
      return 'purchase';
    case 'receipt':
      return 'receipt';
    case 'payment':
      return 'payment';
    case 'contra':
      return 'contra';
    case 'journal':
      return 'journal';
    case 'credit note':
      return 'credit_note';
    case 'debit note':
      return 'debit_note';
    case 'stock journal':
      return 'stock_journal';
    default:
      return 'other';
  }
}

/**
 * Convert vouchers and their entries.
 *
 * `baseTypeOf` resolves a company's custom voucher type to the built-in one it
 * derives from. It is passed in rather than looked up here because the voucher
 * type list is a separate fetch the caller may already have made.
 */
export function adaptVouchers(
  vouchers: readonly TallyVoucher[],
  options: AdapterOptions & { baseTypeOf?: (typeName: string | null) => string | null }
): Adapted<Voucher[]> {
  const warnings: string[] = [];
  const convention = options.signConvention ?? 'side_and_magnitude';
  const baseTypeOf = options.baseTypeOf ?? ((typeName: string | null) => typeName);

  const data = vouchers.map((voucher) => {
    const id = voucher.guid ?? voucher.voucherNumber ?? '(unidentified)';
    const label = `Voucher ${voucher.voucherNumber ?? '(no number)'}`;

    const lines: EntryLine[] = voucher.entries.map((entry, index) => ({
      id: `${id}:${String(index)}`,
      voucherId: id,
      accountId: entry.ledgerName,
      amount: entryAmount(
        entry.amount,
        entry.side,
        `${label}, entry "${entry.ledgerName}"`,
        warnings,
        convention
      ),
      // Party, cost centre, stock and tax all live in Tally's nested
      // structures. They are reachable and deliberately not mapped yet: each
      // needs its own verification against live data, and a half-read tax line
      // is worse than an absent one.
      partyId: null,
      costCentreId: null,
      stockItemId: null,
      quantity: null,
      taxLines: [],
      billReferences: [],
      source: ref('entryLine', `${id}:${String(index)}`),
      ...(entry.fields === undefined ? {} : { raw: entry.fields }),
    }));

    return {
      id,
      entityId: options.entityId,
      date: voucher.date,
      family: classifyVoucherFamily(baseTypeOf(voucher.voucherType)),
      sourceType: voucher.voucherType,
      number: voucher.voucherNumber,
      narration: voucher.narration,
      partyId: voucher.partyLedgerName,
      lines,
      // Tally's edit log is not read by this server yet, so the audit-trail
      // fields are null rather than absent. Null here means "not captured",
      // which several §4 L3 tests will need to distinguish from "no activity".
      createdAt: null,
      createdBy: null,
      lastAlteredAt: null,
      lastAlteredBy: null,
      isCancelled: voucher.isCancelled,
      isDraft: voucher.isOptional,
      documents: [],
      source: adaptSource(voucher.source, 'voucher'),
      ...(voucher.fields === undefined ? {} : { raw: voucher.fields }),
    };
  });

  return { data, warnings };
}
