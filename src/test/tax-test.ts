import { PrivateKey, UInt64, Field, Bool, Poseidon } from "o1js";
import { Balance } from "@proto-kit/library";
import { buildNodeClient } from "../core/environments/node.config";
import {
  TreasuryKey,
  ZARKIS_TOKEN_ID,
} from "../runtime/modules/treasury";
import {
  unitIdFor,
} from "../runtime/modules/unitRegistry";

const GRAPHQL_URL = process.env.PROTOKIT_GRAPHQL_URL ?? "http://localhost:8080/graphql";
const SETTLE_MS = 10000;

const AUTHORITY_PRIVATE_KEY = process.env.MINALIA_AUTHORITY_PRIVATE_KEY;
if (!AUTHORITY_PRIVATE_KEY) {
  console.error("MINALIA_AUTHORITY_PRIVATE_KEY env var is required. Export the same key the chain uses.");
  process.exit(1);
}

async function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function logStep(label: string) {
  console.log("\n" + "=".repeat(60));
  console.log(label);
  console.log("=".repeat(60));
}

async function main() {
  // Authority key from env — same key the chain uses in genesis config.
  // For Tax/UnitRegistry, they still use their own setAuthority calls
  // (those modules haven't been migrated to genesis-config yet).
  // For Treasury, the authority is baked in at chain genesis.
  const authorityKey = PrivateKey.fromBase58(AUTHORITY_PRIVATE_KEY!);
  const authorityPub = authorityKey.toPublicKey();

  const playerKey = PrivateKey.random();
  const playerPub = playerKey.toPublicKey();

  console.log("Authority:", authorityPub.toBase58());
  console.log("Player:", playerPub.toBase58());
  console.log(`Settle wait per tx: ${SETTLE_MS / 1000}s`);

  const client = buildNodeClient(authorityKey, GRAPHQL_URL);
  await client.start();

  const treasury = client.runtime.resolve("MinaliaTreasury");
  const registry = client.runtime.resolve("MinaliaUnitRegistry");
  const tax = client.runtime.resolve("MinaliaTax");

  // Distinctive values so multiple test runs don't collide.
  const TERRITORY_ID = Field(700001);
  const MINISTER_HASH = Field(700099);
  const SLOT = UInt64.from(1);
  const UNIT_ID = unitIdFor(TERRITORY_ID, SLOT);

  // Tax parameters: 30 ARKIS per cycle, cycle = 1 block (fast tests).
  const TAX_AMOUNT = Balance.from(30);
  const CYCLE_BLOCKS = UInt64.from(1);

  const playerVault = TreasuryKey.fromPlayer(playerPub, ZARKIS_TOKEN_ID);
  const ministerVault = TreasuryKey.fromMinister(MINISTER_HASH, ZARKIS_TOKEN_ID);

  async function send(label: string, build: () => Promise<unknown>) {
    console.log(`→ ${label}`);
    const tx = await client.transaction(authorityPub, build as any);
    await tx.sign();
    await tx.send();
    await wait(SETTLE_MS);
  }

  async function getBalance(key: TreasuryKey): Promise<string> {
    const b = await client.query.runtime.MinaliaTreasury.balances.get(key);
    return b?.toString() ?? "0";
  }

  async function getDebt(unitId: Field): Promise<string> {
    const d = await client.query.runtime.MinaliaTax.debts.get(unitId);
    return d?.toString() ?? "0";
  }

  async function expect(label: string, actual: string, expected: string) {
    const pass = actual === expected;
    const symbol = pass ? "✓" : "✗";
    console.log(`  ${symbol} ${label}: got=${actual}, expected=${expected}`);
    return pass;
  }

  let failures = 0;

  // ── SETUP ─────────────────────────────────────────────────────
  logStep("SETUP: bootstrap UnitRegistry + Tax authority + supply cap + register unit");

  // UnitRegistry and Tax still use the setAuthority pattern.
  // Treasury authority is in genesis config — no setAuthority call needed.
  await send("UnitRegistry.setAuthority", async () => {
    await registry.setAuthority(authorityPub);
  });

  await send("Tax.setAuthority", async () => {
    await tax.setAuthority(authorityPub);
  });

  await send("Treasury.setSupplyCap(ZARKIS, 10000)", async () => {
    await treasury.setSupplyCap(ZARKIS_TOKEN_ID, Balance.from(10000));
  });

  await send("UnitRegistry.assignMinister", async () => {
    await registry.assignMinister(TERRITORY_ID, MINISTER_HASH);
  });

  await send("UnitRegistry.registerUnit (slot 1, owner=Player)", async () => {
    await registry.registerUnit(TERRITORY_ID, SLOT, playerPub, Bool(false));
  });

  await send("Tax.setTaxConfig(30, every 1 block)", async () => {
    await tax.setTaxConfig(UNIT_ID, TAX_AMOUNT, CYCLE_BLOCKS);
  });

  // ── TEST 1: happy path ────────────────────────────────────────
  logStep("TEST 1: Happy path — player can afford tax");

  await send("mint 100 to player", async () => {
    await treasury.mint(playerVault, Balance.from(100));
  });

  const balBeforeTax = await getBalance(playerVault);
  const minBeforeTax = await getBalance(ministerVault);
  console.log(`  player balance before tax: ${balBeforeTax}`);
  console.log(`  minister balance before tax: ${minBeforeTax}`);

  await send("Tax.chargeTax(unit)", async () => {
    await tax.chargeTax(UNIT_ID);
  });

  const balAfterTax = await getBalance(playerVault);
  const minAfterTax = await getBalance(ministerVault);
  const debtAfter = await getDebt(UNIT_ID);
  console.log(`  player balance after tax: ${balAfterTax}`);
  console.log(`  minister balance after tax: ${minAfterTax}`);
  console.log(`  debt after tax: ${debtAfter}`);
  if (!await expect("player balance", balAfterTax, "70")) failures++;
  if (!await expect("minister balance", minAfterTax, "30")) failures++;
  if (!await expect("debt", debtAfter, "0")) failures++;

  // ── TEST 2: debt accrual when player can't pay ────────────────
  logStep("TEST 2: Debt accrual — player can't afford tax");

  await send("burn 65 from player (leaves 5)", async () => {
    await treasury.burn(playerVault, Balance.from(65));
  });

  const balBeforeT2 = await getBalance(playerVault);
  console.log(`  player balance before T2: ${balBeforeT2}`);

  await send("Tax.chargeTax(unit) — should accrue", async () => {
    await tax.chargeTax(UNIT_ID);
  });

  const balAfterT2 = await getBalance(playerVault);
  const minAfterT2 = await getBalance(ministerVault);
  const debtAfterT2 = await getDebt(UNIT_ID);
  console.log(`  player balance after T2: ${balAfterT2}`);
  console.log(`  minister balance after T2: ${minAfterT2}`);
  console.log(`  debt after T2: ${debtAfterT2}`);
  if (!await expect("player balance unchanged", balAfterT2, "5")) failures++;
  if (!await expect("minister balance unchanged", minAfterT2, "30")) failures++;
  if (!await expect("debt accrued to 30", debtAfterT2, "30")) failures++;

  // ── TEST 3: debt grows again next cycle ───────────────────────
  logStep("TEST 3: Debt accumulates over consecutive failed cycles");

  await send("Tax.chargeTax(unit) — should accrue again", async () => {
    await tax.chargeTax(UNIT_ID);
  });

  const debtAfterT3 = await getDebt(UNIT_ID);
  const balAfterT3 = await getBalance(playerVault);
  console.log(`  debt after T3: ${debtAfterT3}`);
  if (!await expect("debt now 60", debtAfterT3, "60")) failures++;
  if (!await expect("player balance still 5", balAfterT3, "5")) failures++;

  // ── TEST 4: pay everything when balance is restored ───────────
  logStep("TEST 4: Player gets funds, pays debt + current cycle");

  await send("mint 100 to player", async () => {
    await treasury.mint(playerVault, Balance.from(100));
  });

  await send("Tax.chargeTax(unit) — should pay 90 (debt+amount)", async () => {
    await tax.chargeTax(UNIT_ID);
  });

  const balAfterT4 = await getBalance(playerVault);
  const minAfterT4 = await getBalance(ministerVault);
  const debtAfterT4 = await getDebt(UNIT_ID);
  console.log(`  player balance after T4: ${balAfterT4}`);
  console.log(`  minister balance after T4: ${minAfterT4}`);
  console.log(`  debt after T4: ${debtAfterT4}`);
  if (!await expect("player balance", balAfterT4, "15")) failures++;
  if (!await expect("minister balance", minAfterT4, "120")) failures++;
  if (!await expect("debt cleared", debtAfterT4, "0")) failures++;

  // ── SUMMARY ───────────────────────────────────────────────────
  logStep("SUMMARY");
  if (failures === 0) {
    console.log("✓ All assertions passed");
  } else {
    console.log(`✗ ${failures} assertion(s) failed`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
