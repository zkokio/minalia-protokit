import {
  runtimeModule,
  runtimeMethod,
  RuntimeModule,
} from "@proto-kit/module";
import { StateMap, assert, state } from "@proto-kit/protocol";
import { Balance } from "@proto-kit/library";
import { Field, PublicKey, UInt64, Bool, Struct } from "o1js";
import { inject } from "tsyringe";
import {
  MinaliaTreasury,
  TreasuryKey,
  ZARKIS_TOKEN_ID,
} from "./treasury";
import {
  MinaliaUnitRegistry,
  performUnitTransfer,
} from "./unitRegistry";
import { LEDGER_KIND } from "./ledger";

// 2% fee in basis points. Typed as Balance so they compose with price.mul/div.
export const SALE_FEE_BPS = Balance.from(200);
export const BPS_DENOMINATOR = Balance.from(10000);

export class Listing extends Struct({
  seller: PublicKey,
  price: Balance,
  active: Bool,
}) {}

@runtimeModule()
export class MinaliaSales extends RuntimeModule<unknown> {
  @state() public listings = StateMap.from<Field, Listing>(Field, Listing);

  public constructor(
    @inject("MinaliaTreasury") public treasury: MinaliaTreasury,
    @inject("MinaliaUnitRegistry") public registry: MinaliaUnitRegistry,
  ) {
    super();
  }

  // Seller lists a unit. Asserts seller currently owns it, unit exists,
  // and unit is not minister-held. Price must be positive.
  @runtimeMethod()
  public async list(unitId: Field, price: Balance): Promise<void> {
    // Q9 / A9: prevent zero-price griefing — Sales is for paid transfers.
    assert(price.greaterThan(Balance.from(0)), "Price must be positive");

    const unitResult = await this.registry.units.get(unitId);
    assert(unitResult.value.initialised, "Unit not registered");

    const sender = this.transaction.sender.value;
    assert(
      sender.equals(unitResult.value.owner),
      "Only the current owner can list",
    );

    // A8: minister-held units cannot be sold.
    assert(
      unitResult.value.isMinisterHeld.not(),
      "Minister-held units cannot be listed",
    );

    await this.listings.set(
      unitId,
      new Listing({
        seller: sender,
        price,
        active: Bool(true),
      }),
    );
  }

  // Seller cancels their own listing.
  @runtimeMethod()
  public async cancelListing(unitId: Field): Promise<void> {
    const listingResult = await this.listings.get(unitId);
    assert(listingResult.value.active, "No active listing");

    const sender = this.transaction.sender.value;
    assert(
      sender.equals(listingResult.value.seller),
      "Only the seller can cancel",
    );

    await this.listings.set(
      unitId,
      new Listing({
        seller: listingResult.value.seller,
        price: listingResult.value.price,
        active: Bool(false),
      }),
    );
  }

  // Buyer pays the listed price and atomically receives the unit.
  // Splits: seller gets price - fee, minister gets fee.
  @runtimeMethod()
  public async buy(unitId: Field): Promise<void> {
    const listingResult = await this.listings.get(unitId);
    assert(listingResult.value.active, "No active listing");

    const listing = listingResult.value;
    const buyer = this.transaction.sender.value;

    // Read the unit so we know the minister (and to re-check ownership).
    const unitResult = await this.registry.units.get(unitId);
    assert(unitResult.value.initialised, "Unit not registered");
    const unit = unitResult.value;

    // A7: re-check that the seller still owns the unit. Guards against the
    // case where the unit was admin-transferred between list and buy.
    assert(
      unit.owner.equals(listing.seller),
      "Seller no longer owns this unit",
    );

    // Fee math. Integer division truncates toward zero — small rounding
    // favors the seller at low prices, acceptable at typical denominations.
    const feeRaw = listing.price.mul(SALE_FEE_BPS).div(BPS_DENOMINATOR);
    const fee = Balance.Unsafe.fromField(feeRaw.value);
    const sellerProceeds = Balance.Unsafe.fromField(
      listing.price.sub(fee).value,
    );

    const buyerVault = TreasuryKey.fromPlayer(buyer, ZARKIS_TOKEN_ID);
    const sellerVault = TreasuryKey.fromPlayer(listing.seller, ZARKIS_TOKEN_ID);
    const ministerVault = TreasuryKey.fromMinister(
      unit.minister,
      ZARKIS_TOKEN_ID,
    );

    // Mark inactive BEFORE the transfers. If anything below asserts, the
    // whole tx reverts atomically — including this write — so the listing
    // stays active on failure. On success, future buy attempts on this
    // unitId hit the "No active listing" assertion at the top (A6).
    await this.listings.set(
      unitId,
      new Listing({
        seller: listing.seller,
        price: listing.price,
        active: Bool(false),
      }),
    );

    // Pay the seller (price minus fee).
    await this.treasury.transfer(
      buyerVault,
      sellerVault,
      sellerProceeds,
      LEDGER_KIND.SALE,
    );

    // Pay the minister fee.
    await this.treasury.transfer(
      buyerVault,
      ministerVault,
      fee,
      LEDGER_KIND.SALE_FEE,
    );

    // Atomically move ownership. Uses the shared helper, not a separate
    // @runtimeMethod — so no chain-callable bypass exists.
    await performUnitTransfer(
      this.registry.units,
      this.registry.ledger,
      this.network.block.height,
      unitId,
      buyer,
    );
  }
}
