import {
  runtimeModule,
  runtimeMethod,
  RuntimeModule,
} from "@proto-kit/module";
import { StateMap, State, assert, state } from "@proto-kit/protocol";
import { Balance, TokenId } from "@proto-kit/library";
import { Field, PublicKey, Provable, UInt64, Bool, Struct } from "o1js";
import { inject } from "tsyringe";
import { Balances } from "./balances";

// State for one development. Now lives in a StateMap keyed by devId.
export class DevelopmentState extends Struct({
  manager: PublicKey,
  treasury: PublicKey,
  tokenId: TokenId,
  baseYield: UInt64,
  cycleLength: UInt64,
  tickCount: UInt64,
  lastPayoutTick: UInt64,
  decisionA: UInt64,
  decisionB: UInt64,
  decisionC: UInt64,
  initialised: Bool,
}) {}

@runtimeModule()
export class DevelopmentYield extends RuntimeModule<unknown> {
  @state() public devs = StateMap.from<Field, DevelopmentState>(
    Field,
    DevelopmentState,
  );

  public constructor(@inject("Balances") public balances: Balances) {
    super();
  }

  @runtimeMethod()
  public async initialiseDev(
    devId: Field,
    manager: PublicKey,
    treasury: PublicKey,
    tokenId: TokenId,
    baseYield: Balance,
    cycleLength: UInt64,
  ): Promise<void> {
    const existing = await this.devs.get(devId);
    assert(existing.value.initialised.not(), "Development already initialised");

    await this.devs.set(
      devId,
      new DevelopmentState({
        manager,
        treasury,
        tokenId: tokenId,
        baseYield: UInt64.Unsafe.fromField(baseYield.value),
        cycleLength,
        tickCount: UInt64.zero,
        lastPayoutTick: UInt64.zero,
        decisionA: UInt64.from(100),
        decisionB: UInt64.from(100),
        decisionC: UInt64.from(100),
        initialised: Bool(true),
      }),
    );
  }

  @runtimeMethod()
  public async updateDecisions(
    devId: Field,
    decisionA: UInt64,
    decisionB: UInt64,
    decisionC: UInt64,
  ): Promise<void> {
    const result = await this.devs.get(devId);
    assert(result.value.initialised, "Development not initialised");

    const fifty = UInt64.from(50);
    const twoHundred = UInt64.from(200);
    assert(decisionA.greaterThanOrEqual(fifty), "decisionA below 50");
    assert(decisionA.lessThanOrEqual(twoHundred), "decisionA above 200");
    assert(decisionB.greaterThanOrEqual(fifty), "decisionB below 50");
    assert(decisionB.lessThanOrEqual(twoHundred), "decisionB above 200");
    assert(decisionC.greaterThanOrEqual(fifty), "decisionC below 50");
    assert(decisionC.lessThanOrEqual(twoHundred), "decisionC above 200");

    await this.devs.set(
      devId,
      new DevelopmentState({
        ...result.value,
        decisionA,
        decisionB,
        decisionC,
      }),
    );
  }

  @runtimeMethod()
  public async tick(devId: Field): Promise<void> {
    const result = await this.devs.get(devId);
    const state = result.value;
    assert(state.initialised, "Development not initialised");

    const newTickCount = state.tickCount.add(UInt64.from(1));

    const nextPayoutDue = state.lastPayoutTick.add(state.cycleLength);
    const cycleReady = newTickCount.greaterThanOrEqual(nextPayoutDue);

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
      newTickCount,
      state.lastPayoutTick,
    );

    await this.devs.set(
      devId,
      new DevelopmentState({
        ...state,
        tickCount: newTickCount,
        lastPayoutTick: newLastPayout,
      }),
    );

    Provable.log("tick", {
      devId,
      newTickCount,
      cycleReady,
      yieldToPay,
      managerShare,
      treasuryShare,
    });
  }
}
