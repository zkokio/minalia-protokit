import {
  runtimeModule,
  runtimeMethod,
  RuntimeModule,
} from "@proto-kit/module";
import { StateMap, State, assert, state } from "@proto-kit/protocol";
import { Balance } from "@proto-kit/library";
import { Field, PublicKey, UInt64, Bool, Poseidon, Struct } from "o1js";
import { inject } from "tsyringe";
import { MinaliaLedger, PRINCIPAL_CLASS } from "./ledger";
import { ZARKIS_TOKEN_ID } from "./treasury";
import { MinaliaUnitRegistry } from "./unitRegistry";

export const DEV_EVENT_KIND = {
  REGISTERED: UInt64.from(200),
  UPGRADED: UInt64.from(201),
  ARCHITECT_TRANSFERRED: UInt64.from(202),
  MANAGER_ASSIGNED: UInt64.from(203),
} as const;

// Game design constraint: each unit can hold up to 15 developments.
// Enforced on-chain so misconfigured callers cannot create out-of-range slots.
export const MAX_DEVS_PER_UNIT = UInt64.from(15);

// Sentinel for "no manager assigned." Same convention as TreasuryKey.fromDuelPot
// using Field(0) for an absent identity. Real PublicKeys have non-zero x.
// We use PublicKey.empty() as the canonical no-manager value.
export const NO_MANAGER = PublicKey.empty();

export class DevelopmentState extends Struct({
  unitId: Field,
  devSlot: UInt64,
  devType: UInt64,
  upgradeLevel: UInt64,
  architect: PublicKey,
  manager: PublicKey,
  initialised: Bool,
}) {}

// Derive on-chain development ID from a unit ID + slot index.
// Off-chain code uses the same formula to derive the key.
export function devIdFor(unitId: Field, devSlot: UInt64): Field {
  return Poseidon.hash([unitId, devSlot.value]);
}

@runtimeModule()
export class MinaliaDevelopmentRegistry extends RuntimeModule<unknown> {
  @state() public developments = StateMap.from<Field, DevelopmentState>(
    Field,
    DevelopmentState,
  );

  @state() public authority = State.from<PublicKey>(PublicKey);
  @state() public authorityInitialised = State.from<Bool>(Bool);

  public constructor(
    @inject("MinaliaLedger") public ledger: MinaliaLedger,
    @inject("MinaliaUnitRegistry") public unitRegistry: MinaliaUnitRegistry,
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

  private async assertAuthority(): Promise<void> {
    const initResult = await this.authorityInitialised.get();
    assert(initResult.value, "Authority not initialised");
    const authResult = await this.authority.get();
    const sender = this.transaction.sender.value;
    assert(sender.equals(authResult.value), "Sender is not the authority");
  }

  // Register a new development at unitId/devSlot.
  // devSlot is bounded to MAX_DEVS_PER_UNIT (15) per the game design.
  // Initial manager is the sentinel NO_MANAGER; assignManager sets it later.
  @runtimeMethod()
  public async registerDevelopment(
    unitId: Field,
    devSlot: UInt64,
    devType: UInt64,
    architect: PublicKey,
  ): Promise<void> {
    await this.assertAuthority();

    // Architect must be a real key, not the empty/null sentinel.
    assert(
      architect.equals(NO_MANAGER).not(),
      "Architect cannot be the empty PublicKey",
    );

    // Slot cap: refuse out-of-range slot numbers.
    assert(
      devSlot.lessThanOrEqual(MAX_DEVS_PER_UNIT),
      "Slot number exceeds max",
    );
    // Also reject slot 0 — slots are 1-indexed in MINALIA.
    assert(devSlot.greaterThan(UInt64.zero), "Slot number must be >= 1");

    // The unit must exist in UnitRegistry.
    const unitResult = await this.unitRegistry.units.get(unitId);
    assert(unitResult.value.initialised, "Unit not registered");

    const devId = devIdFor(unitId, devSlot);
    const existing = await this.developments.get(devId);
    assert(
      existing.value.initialised.not(),
      "Slot already occupied: use upgrade or transfer",
    );

    await this.developments.set(
      devId,
      new DevelopmentState({
        unitId,
        devSlot,
        devType,
        upgradeLevel: UInt64.from(1),
        architect,
        manager: NO_MANAGER,
        initialised: Bool(true),
      }),
    );

    await this.ledger.record(
      PRINCIPAL_CLASS.PLAYER,
      Poseidon.hash(architect.toFields()),
      ZARKIS_TOKEN_ID,
      Balance.from(0),
      Balance.from(0),
      DEV_EVENT_KIND.REGISTERED,
      this.network.block.height,
    );
  }

  // Increment the upgrade level of an existing development by 1.
  // No max-level enforced on-chain; that's a Build-module concern.
  @runtimeMethod()
  public async upgradeDevelopment(devId: Field): Promise<void> {
    await this.assertAuthority();

    const result = await this.developments.get(devId);
    assert(result.value.initialised, "Development not registered");

    const current = result.value;
    const newLevel = current.upgradeLevel.add(UInt64.from(1));

    await this.developments.set(
      devId,
      new DevelopmentState({
        unitId: current.unitId,
        devSlot: current.devSlot,
        devType: current.devType,
        upgradeLevel: newLevel,
        architect: current.architect,
        manager: current.manager,
        initialised: Bool(true),
      }),
    );

    await this.ledger.record(
      PRINCIPAL_CLASS.PLAYER,
      Poseidon.hash(current.architect.toFields()),
      ZARKIS_TOKEN_ID,
      Balance.from(0),
      Balance.from(0),
      DEV_EVENT_KIND.UPGRADED,
      this.network.block.height,
    );
  }

  // Change the architect (e.g. when an architect-share is sold).
  @runtimeMethod()
  public async transferArchitect(
    devId: Field,
    newArchitect: PublicKey,
  ): Promise<void> {
    await this.assertAuthority();


    // New architect must be a real key, not the empty/null sentinel.
    assert(
      newArchitect.equals(NO_MANAGER).not(),
      "Architect cannot be the empty PublicKey",
    );
    const result = await this.developments.get(devId);
    assert(result.value.initialised, "Development not registered");

    const current = result.value;
    await this.developments.set(
      devId,
      new DevelopmentState({
        unitId: current.unitId,
        devSlot: current.devSlot,
        devType: current.devType,
        upgradeLevel: current.upgradeLevel,
        architect: newArchitect,
        manager: current.manager,
        initialised: Bool(true),
      }),
    );

    await this.ledger.record(
      PRINCIPAL_CLASS.PLAYER,
      Poseidon.hash(newArchitect.toFields()),
      ZARKIS_TOKEN_ID,
      Balance.from(0),
      Balance.from(0),
      DEV_EVENT_KIND.ARCHITECT_TRANSFERRED,
      this.network.block.height,
    );
  }

  // Assign or change the manager. Pass NO_MANAGER to clear.
  @runtimeMethod()
  public async assignManager(
    devId: Field,
    newManager: PublicKey,
  ): Promise<void> {
    await this.assertAuthority();

    const result = await this.developments.get(devId);
    assert(result.value.initialised, "Development not registered");

    const current = result.value;
    await this.developments.set(
      devId,
      new DevelopmentState({
        unitId: current.unitId,
        devSlot: current.devSlot,
        devType: current.devType,
        upgradeLevel: current.upgradeLevel,
        architect: current.architect,
        manager: newManager,
        initialised: Bool(true),
      }),
    );

    await this.ledger.record(
      PRINCIPAL_CLASS.PLAYER,
      Poseidon.hash(newManager.toFields()),
      ZARKIS_TOKEN_ID,
      Balance.from(0),
      Balance.from(0),
      DEV_EVENT_KIND.MANAGER_ASSIGNED,
      this.network.block.height,
    );
  }
}
