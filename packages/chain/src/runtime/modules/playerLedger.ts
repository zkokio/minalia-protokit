import {
  runtimeModule,
  runtimeMethod,
  RuntimeModule,
} from "@proto-kit/module";
import { StateMap, State, state } from "@proto-kit/protocol";
import { Balance, TokenId } from "@proto-kit/library";
import { PublicKey, UInt64, Struct } from "o1js";

export const LEDGER_KIND = {
  MINT: UInt64.from(1),
  BURN: UInt64.from(2),
  TAX: UInt64.from(3),
  YIELD: UInt64.from(4),
  YIELD_SPLIT: UInt64.from(5),
  WAGE: UInt64.from(6),
  MANAGER_CYCLE: UInt64.from(7),
  SALE: UInt64.from(8),
  SALE_FEE: UInt64.from(9),
  DEV_PERMIT: UInt64.from(10),
  UPGRADE_PERMIT: UInt64.from(11),
  DUEL_STAKE: UInt64.from(12),
  DUEL_PAYOUT: UInt64.from(13),
  DUEL_REFUND: UInt64.from(14),
  EXCHANGE_IN: UInt64.from(15),
  EXCHANGE_OUT: UInt64.from(16),
  EXCHANGE_FEE: UInt64.from(17),
  STAKE_IN: UInt64.from(18),
  STAKE_OUT: UInt64.from(19),
  GATE_ESCROW: UInt64.from(20),
  GATE_REFUND: UInt64.from(21),
  GATE_YIELD: UInt64.from(22),
  BONUS: UInt64.from(23),
  INFLATION: UInt64.from(24),
} as const;

export class LedgerEntry extends Struct({
  player: PublicKey,
  token: TokenId,
  credit: Balance,
  debit: Balance,
  kind: UInt64,
  blockHeight: UInt64,
}) {}

@runtimeModule()
export class MinaliaPlayerLedger extends RuntimeModule<unknown> {
  @state() public entries = StateMap.from<UInt64, LedgerEntry>(UInt64, LedgerEntry);
  @state() public nextIndex = State.from<UInt64>(UInt64);

  public constructor() {
    super();
  }

  @runtimeMethod()
  public async record(
    player: PublicKey,
    token: TokenId,
    credit: Balance,
    debit: Balance,
    kind: UInt64,
    blockHeight: UInt64,
  ): Promise<void> {
    const indexResult = await this.nextIndex.get();
    const index = indexResult.value;

    const entry = new LedgerEntry({
      player,
      token,
      credit,
      debit,
      kind,
      blockHeight,
    });

    await this.entries.set(index, entry);
    await this.nextIndex.set(index.add(UInt64.from(1)));
  }
}
