import {
  runtimeModule,
  runtimeMethod,
  RuntimeModule,
} from "@proto-kit/module";
import { StateMap, State, assert, state } from "@proto-kit/protocol";
import { Balance, TokenId } from "@proto-kit/library";
import { Field, PublicKey, UInt64, Bool, Provable, Struct } from "o1js";
import { inject } from "tsyringe";
import { MinaliaTreasury, TreasuryKey, ZARKIS_TOKEN_ID } from "./treasury";
import { MinaliaUnitRegistry } from "./unitRegistry";
import { LEDGER_KIND } from "./ledger";

export class TaxConfig extends Struct({
  amount: Balance,
  cycleBlocks: UInt64,
  initialised: Bool,
}) {}

@runtimeModule()
export class MinaliaTax extends RuntimeModule<unknown> {
  @state() public configs = StateMap.from<Field, TaxConfig>(Field, TaxConfig);
  @state() public debts = StateMap.from<Field, Balance>(Field, Balance);
  @state() public lastCharged = StateMap.from<Field, UInt64>(Field, UInt64);

  @state() public authority = State.from<PublicKey>(PublicKey);
  @state() public authorityInitialised = State.from<Bool>(Bool);

  public constructor(
    @inject("MinaliaTreasury") public treasury: MinaliaTreasury,
    @inject("MinaliaUnitRegistry") public registry: MinaliaUnitRegistry,
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

  @runtimeMethod()
  public async setTaxConfig(
    unitId: Field,
    amount: Balance,
    cycleBlocks: UInt64,
  ): Promise<void> {
    await this.assertAuthority();

    await this.configs.set(
      unitId,
      new TaxConfig({
        amount,
        cycleBlocks,
        initialised: Bool(true),
      }),
    );
  }

  /**
   * Attempt to charge tax for a unit.
   *
   * Semantics (all-or-nothing with debt accrual):
   *  - Cycle not ready → no-op, state unchanged, no ledger spam.
   *    Enforced by an assertion so callers don't waste blocks.
   *  - Cycle ready, owner can afford debt + this cycle's amount → transfer
   *    the full amount; clear debt; advance lastCharged.
   *  - Cycle ready, owner can't afford → no transfer; accrue this cycle's
   *    amount on top of existing debt; advance lastCharged.
   *
   * Authority-gated. Tax cron / scheduler calls this once per unit per cycle.
   */
  @runtimeMethod()
  public async chargeTax(unitId: Field): Promise<void> {
    await this.assertAuthority();

    const unitResult = await this.registry.units.get(unitId);
    assert(unitResult.value.initialised, "Unit not registered");

    const configResult = await this.configs.get(unitId);
    assert(configResult.value.initialised, "No tax config for unit");

    const unit = unitResult.value;
    const config = configResult.value;

    // Cycle readiness — assert it. Caller's responsibility not to spam.
    // This keeps ledger clean (no zero-amount entries from premature calls).
    const lastResult = await this.lastCharged.get(unitId);
    const last = lastResult.value;
    const now = this.network.block.height;
    const elapsed = now.sub(last);
    assert(
      elapsed.greaterThanOrEqual(config.cycleBlocks),
      "Tax cycle not ready",
    );

    // Read current debt + decide what we'd want to charge.
    const debtResult = await this.debts.get(unitId);
    const currentDebt = debtResult.value;
    const wantToCharge = currentDebt.add(config.amount);

    // Resolve treasury keys.
    const ownerKey = TreasuryKey.fromPlayer(unit.owner, ZARKIS_TOKEN_ID);
    const ministerKey = TreasuryKey.fromMinister(unit.minister, ZARKIS_TOKEN_ID);

    // Read owner balance.
    const ownerBalResult = await this.treasury.balances.get(ownerKey);
    const ownerBal = ownerBalResult.value;
    const canPay = wantToCharge.lessThanOrEqual(ownerBal);

    // Active transfer amount: full wantToCharge if canPay, else 0.
    // Provable.if returns a generic provable value, so cast back to Balance
    // via the Unsafe.fromField escape hatch (pattern from DevelopmentYield).
    const activeChargeRaw = Provable.if(
      canPay,
      Balance,
      wantToCharge,
      Balance.from(0),
    );
    const activeCharge = Balance.Unsafe.fromField(activeChargeRaw.value);

    // New debt: 0 if paid, else accrued total (wantToCharge).
    const newDebtRaw = Provable.if(
      canPay,
      Balance,
      Balance.from(0),
      wantToCharge,
    );
    const newDebt = Balance.Unsafe.fromField(newDebtRaw.value);

    // Always advance lastCharged — the cycle fired either way.
    await this.debts.set(unitId, newDebt);
    await this.lastCharged.set(unitId, now);

    // Issue the transfer. When activeCharge == 0, Treasury writes two
    // zero-amount ledger entries — acceptable as an audit trail for "tax
    // cycle attempted, no payment due to insufficient balance".
    await this.treasury.transfer(
      ownerKey,
      ministerKey,
      activeCharge,
      LEDGER_KIND.TAX,
    );
  }
}
