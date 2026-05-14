import {
  runtimeModule,
  runtimeMethod,
  RuntimeModule,
} from "@proto-kit/module";
import { State, assert, state } from "@proto-kit/protocol";
import { Balance, TokenId } from "@proto-kit/library";
import { PublicKey, Provable, UInt64, Bool, Struct } from "o1js";
import { inject } from "tsyringe";
import { Balances } from "./balances";

// Per-development state. Toy version: ONE development globally.
// Real version would key this by a devId in a StateMap.
export class DevelopmentState extends Struct({
  manager: PublicKey,
  treasury: PublicKey,
  tokenId: TokenId,
  baseYield: UInt64,
  cycleLength: UInt64,
  lastPayoutBlock: UInt64,
  decisionA: UInt64,
  decisionB: UInt64,
  decisionC: UInt64,
  initialised: Bool,
}) {}

@runtimeModule()
export class DevelopmentYield extends RuntimeModule<unknown> {
  @state() public dev = State.from<DevelopmentState>(DevelopmentState);
  @state() public blockHeight = State.from<UInt64>(UInt64);

  public constructor(@inject("Balances") public balances: Balances) {
    super();
  }

  @runtimeMethod()
  public async initialiseDev(
    manager: PublicKey,
    treasury: PublicKey,
    tokenId: TokenId,
    baseYield: Balance,
    cycleLength: UInt64,
  ): Promise<void> {
    const existing = await this.dev.get();
    assert(existing.value.initialised.not(), "Development already initialised");

    await this.dev.set(
      new DevelopmentState({
        manager,
        treasury,
        tokenId: tokenId,
        baseYield: UInt64.Unsafe.fromField(baseYield.value),
        cycleLength,
        lastPayoutBlock: UInt64.zero,
        decisionA: UInt64.from(100),
        decisionB: UInt64.from(100),
        decisionC: UInt64.from(100),
        initialised: Bool(true),
      }),
    );
  }

  @runtimeMethod()
  public async updateDecisions(
    decisionA: UInt64,
    decisionB: UInt64,
    decisionC: UInt64,
  ): Promise<void> {
    const state = (await this.dev.get()).value;
    assert(state.initialised, "Development not initialised");

    const fifty = UInt64.from(50);
    const twoHundred = UInt64.from(200);
    assert(decisionA.greaterThanOrEqual(fifty), "decisionA below 50");
    assert(decisionA.lessThanOrEqual(twoHundred), "decisionA above 200");
    assert(decisionB.greaterThanOrEqual(fifty), "decisionB below 50");
    assert(decisionB.lessThanOrEqual(twoHundred), "decisionB above 200");
    assert(decisionC.greaterThanOrEqual(fifty), "decisionC below 50");
    assert(decisionC.lessThanOrEqual(twoHundred), "decisionC above 200");

    await this.dev.set(
      new DevelopmentState({
        ...state,
        decisionA,
        decisionB,
        decisionC,
      }),
    );
  }

  @runtimeMethod()
  public async tick(): Promise<void> {
    const state = (await this.dev.get()).value;
    assert(state.initialised, "Development not initialised");

    const currentHeight = (await this.blockHeight.get()).value;
    const newHeight = currentHeight.add(UInt64.from(1));
    await this.blockHeight.set(newHeight);

    const nextPayoutDue = state.lastPayoutBlock.add(state.cycleLength);
    const cycleReady = newHeight.greaterThanOrEqual(nextPayoutDue);

    const yieldRaw = state.baseYield
      .mul(state.decisionA)
      .mul(state.decisionB)
      .mul(state.decisionC)
      .div(UInt64.from(1_000_000));

    const yieldToPay = Provable.if(cycleReady, UInt64, yieldRaw, UInt64.zero);

    const managerShare = yieldToPay.mul(UInt64.from(80)).div(UInt64.from(100));
    const treasuryShare = yieldToPay.sub(managerShare);

    await this.balances.mint(
      state.tokenId,
      state.manager,
      Balance.Unsafe.fromField(managerShare.value),
    );
    await this.balances.mint(
      state.tokenId,
      state.treasury,
      Balance.Unsafe.fromField(treasuryShare.value),
    );

    const newLastPayout = Provable.if(
      cycleReady,
      UInt64,
      newHeight,
      state.lastPayoutBlock,
    );
    await this.dev.set(
      new DevelopmentState({
        ...state,
        lastPayoutBlock: newLastPayout,
      }),
    );

    Provable.log("tick", {
      newHeight,
      cycleReady,
      yieldToPay,
      managerShare,
      treasuryShare,
    });
  }
}
