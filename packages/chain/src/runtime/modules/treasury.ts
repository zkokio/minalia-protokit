import {
  runtimeModule,
  runtimeMethod,
  RuntimeModule,
} from "@proto-kit/module";
import { StateMap, assert, state } from "@proto-kit/protocol";
import { Balance, TokenId } from "@proto-kit/library";
import { Field, PublicKey, UInt64, Poseidon, Struct } from "o1js";

export const TREASURY_CLASS = {
  PLAYER: UInt64.from(1),
  MINISTER: UInt64.from(2),
  KING_LUM: UInt64.from(3),
  DUEL_POT: UInt64.from(4),
} as const;

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

  public constructor() {
    super();
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
  }

  @runtimeMethod()
  public async credit(key: TreasuryKey, amount: Balance): Promise<void> {
    const existing = await this.balances.get(key);
    const newBalance = existing.value.add(amount);
    await this.balances.set(key, newBalance);
  }

  @runtimeMethod()
  public async debit(key: TreasuryKey, amount: Balance): Promise<void> {
    const existing = await this.balances.get(key);
    const currentBal = existing.value;
    assert(amount.lessThanOrEqual(currentBal), "Debit exceeds balance");
    await this.balances.set(key, currentBal.sub(amount));
  }

  @runtimeMethod()
  public async transfer(from: TreasuryKey, to: TreasuryKey, amount: Balance): Promise<void> {
    const fromExisting = await this.balances.get(from);
    const fromBal = fromExisting.value;
    assert(amount.lessThanOrEqual(fromBal), "Transfer exceeds source balance");
    await this.balances.set(from, fromBal.sub(amount));

    const toExisting = await this.balances.get(to);
    const toBal = toExisting.value;
    await this.balances.set(to, toBal.add(amount));
  }
}
