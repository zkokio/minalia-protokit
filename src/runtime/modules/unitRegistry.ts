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

// New ledger kinds for unit lifecycle. Not money movements but worth logging
// as audit events. Reuse the ledger as a generic event log with credit=0,debit=0.
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

export class TerritoryState extends Struct({
  minister: Field,
  initialised: Bool,
}) {}

// Compute on-chain unit ID from a territory id + slot number.
// Off-chain code uses the same formula to derive the key.
export function unitIdFor(territoryId: Field, slot: UInt64): Field {
  return Poseidon.hash([territoryId, slot.value]);
}

@runtimeModule()
export class MinaliaUnitRegistry extends RuntimeModule<unknown> {
  @state() public units = StateMap.from<Field, UnitState>(Field, UnitState);
  @state() public territories = StateMap.from<Field, TerritoryState>(
    Field,
    TerritoryState,
  );

  // Authority key controls all mutating methods. Set once via setAuthority.
  @state() public authority = State.from<PublicKey>(PublicKey);
  @state() public authorityInitialised = State.from<Bool>(Bool);

  public constructor(
    @inject("MinaliaLedger") public ledger: MinaliaLedger,
  ) {
    super();
  }

  // Called once during bootstrap. After this, only the holder of `key`
  // can register units, transfer them, or assign ministers.
  @runtimeMethod()
  public async setAuthority(key: PublicKey): Promise<void> {
    const initResult = await this.authorityInitialised.get();
    assert(initResult.value.not(), "Authority already initialised");
    await this.authority.set(key);
    await this.authorityInitialised.set(Bool(true));
  }

  // Assert the tx signer matches the configured authority key.
  // Note: this.transaction.sender is a PublicKeyOption; .value is the PublicKey.
  private async assertAuthority(): Promise<void> {
    const initResult = await this.authorityInitialised.get();
    assert(initResult.value, "Authority not initialised");
    const authResult = await this.authority.get();
    const sender = this.transaction.sender.value;
    assert(sender.equals(authResult.value), "Sender is not the authority");
  }

  @runtimeMethod()
  public async assignMinister(
    territoryId: Field,
    ministerHash: Field,
  ): Promise<void> {
    await this.assertAuthority();

    await this.territories.set(
      territoryId,
      new TerritoryState({
        minister: ministerHash,
        initialised: Bool(true),
      }),
    );

    // Audit event in the ledger. Zero amounts; principal = the minister.
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

    // Territory must have been initialised so we know the minister.
    const territoryResult = await this.territories.get(territoryId);
    assert(
      territoryResult.value.initialised,
      "Territory not initialised: assignMinister first",
    );

    const unitId = unitIdFor(territoryId, slot);

    // Refuse to overwrite an existing unit. Use transferUnit instead.
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

  @runtimeMethod()
  public async transferUnit(
    unitId: Field,
    newOwner: PublicKey,
  ): Promise<void> {
    await this.assertAuthority();

    const result = await this.units.get(unitId);
    assert(result.value.initialised, "Unit not registered");

    const current = result.value;
    await this.units.set(
      unitId,
      new UnitState({
        owner: newOwner,
        minister: current.minister,
        territoryId: current.territoryId,
        slot: current.slot,
        // A transferred unit is no longer minister-held by definition.
        isMinisterHeld: Bool(false),
        initialised: Bool(true),
      }),
    );

    await this.ledger.record(
      PRINCIPAL_CLASS.PLAYER,
      Poseidon.hash(newOwner.toFields()),
      ZARKIS_TOKEN_ID,
      Balance.from(0),
      Balance.from(0),
      UNIT_EVENT_KIND.TRANSFERRED,
      this.network.block.height,
    );
  }
}
