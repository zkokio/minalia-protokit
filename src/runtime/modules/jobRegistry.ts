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
import { MinaliaTreasury, TreasuryKey, ZARKIS_TOKEN_ID, performForceTransfer } from "./treasury";
import { MinaliaUnitRegistry } from "./unitRegistry";
import { MinaliaDevelopmentRegistry } from "./developmentRegistry";

export const JOB_EVENT_KIND = {
  EMPLOYMENT_STARTED: UInt64.from(400),
  EMPLOYMENT_TERMINATED: UInt64.from(401),
  WAGE_PAID: UInt64.from(402),
} as const;

// Employment status values. Field rather than UInt64 because we only ever
// compare equality, no arithmetic.
export const EMPLOYMENT_STATUS = {
  // No employment exists at this job slot (also the default-zero value).
  NONE: Field(0),
  // Active employment, eligible for payCycle.
  ACTIVE: Field(1),
  // Terminated by minister OR resigned via off-chain UI flow (which
  // routes to minister-signed terminate). No further payouts allowed.
  TERMINATED: Field(2),
} as const;

export class EmploymentState extends Struct({
  // Identity
  unitId: Field,                // FK into UnitRegistry — for territory/minister lookup
  devId: Field,                 // FK into DevelopmentRegistry — the dev being managed
  employee: PublicKey,          // The hired player

  // Economics — both fixed at hire time, immutable for the life of the
  // employment. To change either, terminate and re-hire.
  weeklyWageArkis: Balance,     // Wage paid each cycle
  cycleBlocks: UInt64,          // Min blocks between payouts (anti-replay cadence).
                                // Minister-set at hire. NOT mutable afterward and
                                // NOT settable by employee/intruder — the only path
                                // to set it is startEmployment, which is gated by
                                // assertMinisterOf. This is what keeps the guard
                                // safe: testability and security share one path.

  // Lifecycle
  startedAt: UInt64,            // block height at startEmployment
  currentCycleN: UInt64,        // increments each successful payCycle (audit/UI only)
  lastPayoutAt: UInt64,         // block height of last successful payCycle
  status: Field,                // EMPLOYMENT_STATUS.*

  initialised: Bool,
}) {}

// Production reference cadence: one real week, assuming ~3-second blocks.
// 7 * 24 * 60 * 60 / 3 = 201,600 blocks. This is a DEFAULT/REFERENCE only —
// the enforced value lives per-employment in EmploymentState.cycleBlocks,
// set by the minister at hire time. Adjust this reference if block time
// differs; it does not change any on-chain behaviour by itself.
//
// TODO: when planet-time formula is anchored on-chain (1 real hour = 1 Lum day),
// derive cadences from planet-time rather than a raw block count.
export const MIN_CYCLE_BLOCKS = UInt64.from(201_600);

// Deterministic id for an employment, keyed by devId. One active employment
// per dev at a time. (We could allow multiple roles per dev in future by
// adding a roleSlot; for now: 1 dev = 1 employment.)
export function employmentIdFor(devId: Field): Field {
  return Poseidon.hash([devId]);
}

// Per-territory minister-gated. Each method asserts the sender is the
// minister of the unit's territory (via UnitRegistry.assertMinisterOf).
// Follows the same authority pattern as MinaliaDevelopmentRegistry — no
// deployer field, no king field. Every employment op is intrinsically
// a minister-of-this-unit's-territory op.
@runtimeModule()
export class MinaliaJobRegistry extends RuntimeModule<Record<string, never>> {
  @state() public employments = StateMap.from<Field, EmploymentState>(
    Field,
    EmploymentState,
  );

  public constructor(
    @inject("MinaliaLedger") public ledger: MinaliaLedger,
    @inject("MinaliaTreasury") public treasury: MinaliaTreasury,
    @inject("MinaliaUnitRegistry") public unitRegistry: MinaliaUnitRegistry,
    @inject("MinaliaDevelopmentRegistry") public devRegistry: MinaliaDevelopmentRegistry,
  ) {
    super();
  }

  // Start an employment: bind a player to a development as its manager,
  // with a wage and a payout cadence. Caller must be the minister of the
  // unit's territory.
  //
  // Calls assertMinisterOf on the unit. Also sets DevelopmentRegistry's
  // `manager` field to the same employee via assignManager — that path
  // ALSO does its own minister check, so the call is safe regardless of
  // which way we got here.
  //
  // cycleBlocks is the minimum block gap between payouts, fixed here for
  // the life of the employment. It can only be set via this minister-gated
  // method — there is no runtime setter — so it cannot be retuned by an
  // attacker to defeat the anti-replay guard.
  @runtimeMethod()
  public async startEmployment(
    unitId: Field,
    devId: Field,
    employee: PublicKey,
    weeklyWageArkis: Balance,
    cycleBlocks: UInt64,
  ): Promise<void> {
    // Sender is minister of this unit's territory? (Also asserts unit exists.)
    await this.unitRegistry.assertMinisterOf(unitId);

    assert(
      employee.equals(PublicKey.empty()).not(),
      "Employee cannot be the empty PublicKey",
    );

    // Cadence must be positive — a zero-gap cadence would defeat the
    // anti-replay guard entirely.
    assert(cycleBlocks.greaterThan(UInt64.zero), "cycleBlocks must be >= 1");

    // Dev must be registered and on the unit we're claiming.
    const devResult = await this.devRegistry.developments.get(devId);
    assert(devResult.value.initialised, "Development not registered");
    assert(
      devResult.value.unitId.equals(unitId),
      "Dev does not belong to specified unit",
    );

    const empId = employmentIdFor(devId);
    const existing = await this.employments.get(empId);

    // Allow re-hiring after a prior employment was terminated, but block
    // double-hire onto an already-active employment.
    assert(
      existing.value.status.equals(EMPLOYMENT_STATUS.ACTIVE).not(),
      "Employment already active on this dev",
    );

    const blockHeight = this.network.block.height;

    await this.employments.set(
      empId,
      new EmploymentState({
        unitId,
        devId,
        employee,
        weeklyWageArkis,
        cycleBlocks,
        startedAt: blockHeight,
        currentCycleN: UInt64.zero,
        // Setting lastPayoutAt = startedAt means the first payCycle can
        // only fire cycleBlocks after employment starts. Prevents an
        // immediate-after-hire payout.
        lastPayoutAt: blockHeight,
        status: EMPLOYMENT_STATUS.ACTIVE,
        initialised: Bool(true),
      }),
    );

    // Sync DevelopmentRegistry's manager field. Same minister-tx, so the
    // inner assertMinisterOf in assignManager passes by construction.
    await this.devRegistry.assignManager(devId, employee);

    await this.ledger.record(
      PRINCIPAL_CLASS.PLAYER,
      Poseidon.hash(employee.toFields()),
      ZARKIS_TOKEN_ID,
      Balance.from(0),
      Balance.from(0),
      JOB_EVENT_KIND.EMPLOYMENT_STARTED,
      blockHeight,
    );
  }

  // Terminate an active employment. Caller must be the minister of the
  // unit's territory.
  //
  // Used for both minister-fires-employee and player-resigns (routed via
  // off-chain UI → edge function signs as the minister). The chain doesn't
  // distinguish the two — there is one terminal state.
  //
  // Also clears DevelopmentRegistry.manager back to NO_MANAGER so the
  // dev's record reflects no active manager.
  @runtimeMethod()
  public async terminate(devId: Field): Promise<void> {
    const empId = employmentIdFor(devId);
    const result = await this.employments.get(empId);
    assert(result.value.initialised, "Employment does not exist");
    assert(
      result.value.status.equals(EMPLOYMENT_STATUS.ACTIVE),
      "Employment is not active",
    );

    const current = result.value;
    await this.unitRegistry.assertMinisterOf(current.unitId);

    await this.employments.set(
      empId,
      new EmploymentState({
        unitId: current.unitId,
        devId: current.devId,
        employee: current.employee,
        weeklyWageArkis: current.weeklyWageArkis,
        cycleBlocks: current.cycleBlocks,
        startedAt: current.startedAt,
        currentCycleN: current.currentCycleN,
        lastPayoutAt: current.lastPayoutAt,
        status: EMPLOYMENT_STATUS.TERMINATED,
        initialised: Bool(true),
      }),
    );

    // Clear DevelopmentRegistry.manager.
    await this.devRegistry.assignManager(devId, PublicKey.empty());

    await this.ledger.record(
      PRINCIPAL_CLASS.PLAYER,
      Poseidon.hash(current.employee.toFields()),
      ZARKIS_TOKEN_ID,
      Balance.from(0),
      Balance.from(0),
      JOB_EVENT_KIND.EMPLOYMENT_TERMINATED,
      this.network.block.height,
    );
  }

  // Pay one cycle's wage to the employee. Caller must be the minister of
  // the unit's territory. The minister's territory treasury funds the
  // wage; if it has insufficient balance, the inner performForceTransfer
  // assertion fails and the whole tx reverts — no partial state, and the
  // cycle counter does NOT advance.
  //
  // Anti-replay: requires currentBlock - lastPayoutAt >= cycleBlocks (the
  // per-employment cadence set at hire). In production the minister-side
  // cron decides when to call this; the chain guards against early/double pay.
  @runtimeMethod()
  public async payCycle(devId: Field): Promise<void> {
    const empId = employmentIdFor(devId);
    const result = await this.employments.get(empId);
    assert(result.value.initialised, "Employment does not exist");
    assert(
      result.value.status.equals(EMPLOYMENT_STATUS.ACTIVE),
      "Employment is not active",
    );

    const current = result.value;
    await this.unitRegistry.assertMinisterOf(current.unitId);

    const blockHeight = this.network.block.height;
    assert(
      blockHeight
        .sub(current.lastPayoutAt)
        .greaterThanOrEqual(current.cycleBlocks),
      "Too soon since last payout",
    );

    // Resolve the unit, which already stores the minister hash and
    // territory. Tax.chargeTax shows the convention: use unit.minister
    // directly as the keyHash for TreasuryKey.fromMinister — it's
    // already the right Field (set by registerUnit from
    // territories[territoryId].minister).
    const unitResult = await this.unitRegistry.units.get(current.unitId);
    assert(unitResult.value.initialised, "Unit no longer registered");
    const unit = unitResult.value;

    const from = TreasuryKey.fromMinister(unit.minister, ZARKIS_TOKEN_ID);
    const to = TreasuryKey.fromPlayer(current.employee, ZARKIS_TOKEN_ID);

    // Move the wage. This will revert the whole tx if the minister's
    // treasury doesn't have enough ZARKIS — guarantee of no half-applied
    // state, and the cycle counter below is never reached on revert.
    await performForceTransfer(
      this.treasury.balances,
      this.ledger,
      blockHeight,
      from,
      to,
      current.weeklyWageArkis,
      JOB_EVENT_KIND.WAGE_PAID,
    );

    // Update cycle counter + lastPayoutAt. Preserves cycleBlocks.
    await this.employments.set(
      empId,
      new EmploymentState({
        unitId: current.unitId,
        devId: current.devId,
        employee: current.employee,
        weeklyWageArkis: current.weeklyWageArkis,
        cycleBlocks: current.cycleBlocks,
        startedAt: current.startedAt,
        currentCycleN: current.currentCycleN.add(UInt64.from(1)),
        lastPayoutAt: blockHeight,
        status: EMPLOYMENT_STATUS.ACTIVE,
        initialised: Bool(true),
      }),
    );
  }
}
