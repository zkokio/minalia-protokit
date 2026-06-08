import {
  runtimeModule,
  runtimeMethod,
  RuntimeModule,
} from "@proto-kit/module";
import { StateMap, assert, state } from "@proto-kit/protocol";
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
export const MAX_DEVS_PER_UNIT = UInt64.from(15);

// Sentinel for "no manager assigned." Same convention as TreasuryKey.fromDuelPot
// using Field(0) for an absent identity. We use PublicKey.empty() as the
// canonical no-manager value.
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

export function devIdFor(unitId: Field, devSlot: UInt64): Field {
  return Poseidon.hash([unitId, devSlot.value]);
}

// Per-territory minister-gated. Each method asserts the sender is the
// minister of the unit's territory (via UnitRegistry.assertMinisterOf).
// No deployer-gating: governance ops on developments don't exist yet -
// if one is ever added, this module can take a config field for it.
@runtimeModule()
export class MinaliaDevelopmentRegistry extends RuntimeModule<Record<string, never>> {
  @state() public developments = StateMap.from<Field, DevelopmentState>(
    Field,
    DevelopmentState,
  );

  public constructor(
    @inject("MinaliaLedger") public ledger: MinaliaLedger,
    @inject("MinaliaUnitRegistry") public unitRegistry: MinaliaUnitRegistry,
  ) {
    super();
  }

  // Register a new development at unitId/devSlot.
  // Caller must be the minister of the unit's territory.
  @runtimeMethod()
  public async registerDevelopment(
    unitId: Field,
    devSlot: UInt64,
    devType: UInt64,
    architect: PublicKey,
  ): Promise<void> {
    // Asserts unit exists + sender is the minister of unit's territory.
    await this.unitRegistry.assertMinisterOf(unitId);

    assert(
      architect.equals(NO_MANAGER).not(),
      "Architect cannot be the empty PublicKey",
    );
    assert(
      devSlot.lessThanOrEqual(MAX_DEVS_PER_UNIT),
      "Slot number exceeds max",
    );
    assert(devSlot.greaterThan(UInt64.zero), "Slot number must be >= 1");

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
  // Caller must be the minister of the dev's unit's territory.
  @runtimeMethod()
  public async upgradeDevelopment(devId: Field): Promise<void> {
    const result = await this.developments.get(devId);
    assert(result.value.initialised, "Development not registered");

    const current = result.value;
    await this.unitRegistry.assertMinisterOf(current.unitId);

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
  // Caller must be the minister of the dev's unit's territory.
  @runtimeMethod()
  public async transferArchitect(
    devId: Field,
    newArchitect: PublicKey,
  ): Promise<void> {
    assert(
      newArchitect.equals(NO_MANAGER).not(),
      "Architect cannot be the empty PublicKey",
    );
    const result = await this.developments.get(devId);
    assert(result.value.initialised, "Development not registered");

    const current = result.value;
    await this.unitRegistry.assertMinisterOf(current.unitId);

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
  // Caller must be the minister of the dev's unit's territory.
  @runtimeMethod()
  public async assignManager(
    devId: Field,
    newManager: PublicKey,
  ): Promise<void> {
    const result = await this.developments.get(devId);
    assert(result.value.initialised, "Development not registered");

    const current = result.value;
    await this.unitRegistry.assertMinisterOf(current.unitId);

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
