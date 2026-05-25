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

export const UNIT_EVENT_KIND = {
  REGISTERED: UInt64.from(100),
  TRANSFERRED: UInt64.from(101),
  MINISTER_ASSIGNED: UInt64.from(102),
} as const;

export class UnitState extends Struct({
  owner: PublicKey,
  minister: Field,
  territoryId: Field,
  slot: UInt64,
  isMinisterHeld: Bool,
  initialised: Bool,
}) {}

// TerritoryState carries two pieces of minister info:
//   - minister:    Field hash of the Minalien NFT identity ("which NFT is the minister")
//   - ministerKey: PublicKey of the keypair that signs minister txs ("which key signs")
// Both are set once at bootstrap via assignMinister and never changed.
// Immutable by design: no on-chain rotation path. If a minister key is
// lost or compromised, recovery is at the game layer (area relaunch).
export class TerritoryState extends Struct({
  minister: Field,
  ministerKey: PublicKey,
  initialised: Bool,
}) {}

export function unitIdFor(territoryId: Field, slot: UInt64): Field {
  return Poseidon.hash([territoryId, slot.value]);
}

// Intentionally NOT a @runtimeMethod. This helper performs the actual
// ownership swap on a unit. It is only callable from inside another
// @runtimeMethod that has already done its own access control (e.g.
// UnitRegistry.transferUnit checks authority; Sales.buy checks listing
// validity + payment). There is no chain-addressable path here — a user
// transaction cannot invoke this function directly.
//
// Per the Protokit team's recommended pattern (May 2026) for module
// composition: shared mutation lives in a plain helper, callers are
// @runtimeMethods that gate their own entry.
export async function performUnitTransfer(
  units: StateMap<Field, UnitState>,
  ledger: MinaliaLedger,
  blockHeight: UInt64,
  unitId: Field,
  newOwner: PublicKey,
): Promise<void> {
  const result = await units.get(unitId);
  assert(result.value.initialised, "Unit not registered");

  const current = result.value;
  await units.set(
    unitId,
    new UnitState({
      owner: newOwner,
      minister: current.minister,
      territoryId: current.territoryId,
      slot: current.slot,
      // After any transfer the unit is no longer minister-held.
      isMinisterHeld: Bool(false),
      initialised: Bool(true),
    }),
  );

  await ledger.record(
    PRINCIPAL_CLASS.PLAYER,
    Poseidon.hash(newOwner.toFields()),
    ZARKIS_TOKEN_ID,
    Balance.from(0),
    Balance.from(0),
    UNIT_EVENT_KIND.TRANSFERRED,
    blockHeight,
  );
}

// Genesis-config authority key. Set in runtime/index.ts via the module
// config object — baked into the chain from block 0. No runtime method
// to change it, no race window to front-run.
interface UnitRegistryConfig {
  authority: PublicKey;
}

@runtimeModule()
export class MinaliaUnitRegistry extends RuntimeModule<UnitRegistryConfig> {
  @state() public units = StateMap.from<Field, UnitState>(Field, UnitState);
  @state() public territories = StateMap.from<Field, TerritoryState>(
    Field,
    TerritoryState,
  );

  public constructor(
    @inject("MinaliaLedger") public ledger: MinaliaLedger,
  ) {
    super();
  }

  // Private helper used by methods that need authority gating.
  // Authority comes from genesis config, not from runtime state.
  private async assertAuthority(): Promise<void> {
    const sender = this.transaction.sender.value;
    assert(
      sender.equals(this.config.authority),
      "Sender is not the authority",
    );
  }

  // Asserts that the transaction sender is the minister of the territory
  // that the given unit belongs to. Used by Tax (and later by
  // DevelopmentRegistry) to gate per-territory operations.
  // NOT a @runtimeMethod — called from inside other modules' methods.
  public async assertMinisterOf(unitId: Field): Promise<void> {
    const unitResult = await this.units.get(unitId);
    assert(unitResult.value.initialised, "Unit not registered");

    const territoryResult = await this.territories.get(
      unitResult.value.territoryId,
    );
    assert(
      territoryResult.value.initialised,
      "Territory not initialised",
    );

    const sender = this.transaction.sender.value;
    assert(
      sender.equals(territoryResult.value.ministerKey),
      "Sender is not the minister of this territory",
    );
  }

  // Bootstrap-only: assign a minister to a territory. Sets BOTH the
  // in-game NFT identity (ministerHash) AND the crypto key the minister
  // uses to sign transactions (ministerKey). Once set, neither can be
  // changed — there is no rotation path by design.
  @runtimeMethod()
  public async assignMinister(
    territoryId: Field,
    ministerHash: Field,
    ministerKey: PublicKey,
  ): Promise<void> {
    await this.assertAuthority();

    await this.territories.set(
      territoryId,
      new TerritoryState({
        minister: ministerHash,
        ministerKey,
        initialised: Bool(true),
      }),
    );

    await this.ledger.record(
      PRINCIPAL_CLASS.MINISTER,
      ministerHash,
      ZARKIS_TOKEN_ID,
      Balance.from(0),
      Balance.from(0),
      UNIT_EVENT_KIND.MINISTER_ASSIGNED,
      this.network.block.height,
    );
  }

  @runtimeMethod()
  public async registerUnit(
    territoryId: Field,
    slot: UInt64,
    owner: PublicKey,
    isMinisterHeld: Bool,
  ): Promise<void> {
    await this.assertAuthority();

    const territoryResult = await this.territories.get(territoryId);
    assert(
      territoryResult.value.initialised,
      "Territory not initialised: assignMinister first",
    );

    const unitId = unitIdFor(territoryId, slot);
    const existingResult = await this.units.get(unitId);
    assert(
      existingResult.value.initialised.not(),
      "Unit already registered: use transferUnit",
    );

    await this.units.set(
      unitId,
      new UnitState({
        owner,
        minister: territoryResult.value.minister,
        territoryId,
        slot,
        isMinisterHeld,
        initialised: Bool(true),
      }),
    );

    await this.ledger.record(
      PRINCIPAL_CLASS.PLAYER,
      Poseidon.hash(owner.toFields()),
      ZARKIS_TOKEN_ID,
      Balance.from(0),
      Balance.from(0),
      UNIT_EVENT_KIND.REGISTERED,
      this.network.block.height,
    );
  }

  // Authority-gated direct transfer. Used at bootstrap or for admin
  // actions. Player-driven transfers go through MinaliaSales.buy, which
  // calls the same performUnitTransfer helper after its own validation.
  @runtimeMethod()
  public async transferUnit(
    unitId: Field,
    newOwner: PublicKey,
  ): Promise<void> {
    await this.assertAuthority();
    await performUnitTransfer(
      this.units,
      this.ledger,
      this.network.block.height,
      unitId,
      newOwner,
    );
  }
}
