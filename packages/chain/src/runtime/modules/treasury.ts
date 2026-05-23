import {
  runtimeModule,
  runtimeMethod,
  RuntimeModule,
} from "@proto-kit/module";
import { StateMap, State, assert, state } from "@proto-kit/protocol";
import { Balance, TokenId } from "@proto-kit/library";
import { Field, PublicKey, UInt64, Bool, Poseidon, Struct } from "o1js";
import { inject } from "tsyringe";
import { MinaliaLedger, LEDGER_KIND } from "./ledger";

export const TREASURY_CLASS = {
  PLAYER: UInt64.from(1),
  MINISTER: UInt64.from(2),
  KING_LUM: UInt64.from(3),
  DUEL_POT: UInt64.from(4),
} as const;

export const ZARKIS_TOKEN_ID = TokenId.from(1);

export class TreasuryKey extends Struct({
  treasuryClass: UInt64,
  keyHash: Field,
  tokenId: TokenId,
}) {
  static fromPlayer(player: PublicKey, tokenId: TokenId): TreasuryKey {
    return new TreasuryKey({
      treasuryClass: TREASURY_CLASS.PLAYER,
      keyHash: Poseidon.hash(player.toFields()),
      tokenId,
    });
  }
  static fromMinister(territoryHash: Field, tokenId: TokenId): TreasuryKey {
    return new TreasuryKey({
      treasuryClass: TREASURY_CLASS.MINISTER,
      keyHash: territoryHash,
      tokenId,
    });
  }
  static fromKingLum(areaHash: Field, tokenId: TokenId): TreasuryKey {
    return new TreasuryKey({
      treasuryClass: TREASURY_CLASS.KING_LUM,
      keyHash: areaHash,
      tokenId,
    });
  }
  static fromDuelPot(tokenId: TokenId): TreasuryKey {
    return new TreasuryKey({
      treasuryClass: TREASURY_CLASS.DUEL_POT,
      keyHash: Field(0),
      tokenId,
    });
  }
}

export class SupplyState extends Struct({
  minted: Balance,
  burned: Balance,
  cap: Balance,
}) {}

@runtimeModule()
export class MinaliaTreasury extends RuntimeModule<unknown> {
  @state() public balances = StateMap.from<TreasuryKey, Balance>(TreasuryKey, Balance);
  @state() public supplies = StateMap.from<TokenId, SupplyState>(TokenId, SupplyState);

  // Authority key for admin operations. Set once via setAuthority at bootstrap.
  // NOTE: in step 1 these fields exist but no existing methods enforce the check.
  // Subsequent steps gate setSupplyCap, mint, burn, and add forceTransfer.
  @state() public authority = State.from<PublicKey>(PublicKey);
  @state() public authorityInitialised = State.from<Bool>(Bool);

  public constructor(
    @inject("MinaliaLedger") public ledger: MinaliaLedger,
  ) {
    super();
  }

  @runtimeMethod()
  public async setAuthority(key: PublicKey): Promise<void> {
    const initResult = await this.authorityInitialised.get();
    assert(initResult.value.not(), "Authority already initialised");
    await this.authority.set(key);
    await this.authorityInitialised.set(Bool(true));
  }

  // Private helper used by methods that need authority gating.
  // Unused in step 1 — added now so step 2 can apply it to setSupplyCap.
  private async assertAuthority(): Promise<void> {
    const initResult = await this.authorityInitialised.get();
    assert(initResult.value, "Authority not initialised");
    const authResult = await this.authority.get();
    const sender = this.transaction.sender.value;
    assert(sender.equals(authResult.value), "Sender is not the authority");
  }

  @runtimeMethod()
  public async setSupplyCap(tokenId: TokenId, cap: Balance): Promise<void> {
    const existing = await this.supplies.get(tokenId);
    const current = existing.value;
    await this.supplies.set(tokenId, new SupplyState({
      minted: current.minted,
      burned: current.burned,
      cap,
    }));
  }

  @runtimeMethod()
  public async mint(key: TreasuryKey, amount: Balance): Promise<void> {
    const isDuelPot = key.treasuryClass.equals(TREASURY_CLASS.DUEL_POT);
    const isZarkis = key.tokenId.equals(ZARKIS_TOKEN_ID);
    assert(isDuelPot.not().or(isZarkis), "DUEL-POT only accepts ZARKIS");

    const supplyResult = await this.supplies.get(key.tokenId);
    const supply = supplyResult.value;

    const newMinted = supply.minted.add(amount);
    const inCirculation = newMinted.sub(supply.burned);
    assert(inCirculation.lessThanOrEqual(supply.cap), "Mint would exceed supply cap");

    const existing = await this.balances.get(key);
    const newBalance = existing.value.add(amount);
    await this.balances.set(key, newBalance);

    await this.supplies.set(key.tokenId, new SupplyState({
      minted: newMinted,
      burned: supply.burned,
      cap: supply.cap,
    }));

    // Ledger: credit on the recipient
    await this.ledger.record(
      key.treasuryClass,
      key.keyHash,
      key.tokenId,
      amount,
      Balance.from(0),
      LEDGER_KIND.MINT,
      this.network.block.height,
    );
  }

  @runtimeMethod()
  public async burn(key: TreasuryKey, amount: Balance): Promise<void> {
    const existing = await this.balances.get(key);
    const currentBal = existing.value;
    assert(amount.lessThanOrEqual(currentBal), "Burn exceeds balance");
    await this.balances.set(key, currentBal.sub(amount));

    const supplyResult = await this.supplies.get(key.tokenId);
    const supply = supplyResult.value;
    await this.supplies.set(key.tokenId, new SupplyState({
      minted: supply.minted,
      burned: supply.burned.add(amount),
      cap: supply.cap,
    }));

    // Ledger: debit on the source
    await this.ledger.record(
      key.treasuryClass,
      key.keyHash,
      key.tokenId,
      Balance.from(0),
      amount,
      LEDGER_KIND.BURN,
      this.network.block.height,
    );
  }

  @runtimeMethod()
  public async transfer(
    from: TreasuryKey,
    to: TreasuryKey,
    amount: Balance,
    kind: UInt64,
  ): Promise<void> {
    const toIsDuelPot = to.treasuryClass.equals(TREASURY_CLASS.DUEL_POT);
    const isZarkis = to.tokenId.equals(ZARKIS_TOKEN_ID);
    assert(toIsDuelPot.not().or(isZarkis), "DUEL-POT only accepts ZARKIS");

    const fromExisting = await this.balances.get(from);
    const fromBal = fromExisting.value;
    assert(amount.lessThanOrEqual(fromBal), "Transfer exceeds source balance");
    await this.balances.set(from, fromBal.sub(amount));

    const toExisting = await this.balances.get(to);
    const toBal = toExisting.value;
    await this.balances.set(to, toBal.add(amount));

    const blockHeight = this.network.block.height;

    // Ledger: debit on `from`
    await this.ledger.record(
      from.treasuryClass,
      from.keyHash,
      from.tokenId,
      Balance.from(0),
      amount,
      kind,
      blockHeight,
    );

    // Ledger: credit on `to`
    await this.ledger.record(
      to.treasuryClass,
      to.keyHash,
      to.tokenId,
      amount,
      Balance.from(0),
      kind,
      blockHeight,
    );
  }
}
