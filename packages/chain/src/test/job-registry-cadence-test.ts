import { PrivateKey, UInt64, Field, Bool, Poseidon } from "o1js";
import { Balance, TokenId } from "@proto-kit/library";
import { buildNodeClient } from "../core/environments/node.config";
import { unitIdFor } from "../runtime/modules/unitRegistry";
import { devIdFor } from "../runtime/modules/developmentRegistry";
import { employmentIdFor, EMPLOYMENT_STATUS } from "../runtime/modules/jobRegistry";
import { TreasuryKey, ZARKIS_TOKEN_ID } from "../runtime/modules/treasury";

const GRAPHQL_URL = process.env.PROTOKIT_GRAPHQL_URL ?? "http://localhost:8080/graphql";
const SETTLE_MS = 10000;

const DEPLOYER_PRIVATE_KEY = process.env.MINALIA_DEPLOYER_PRIVATE_KEY;
if (!DEPLOYER_PRIVATE_KEY) {
  console.error("MINALIA_DEPLOYER_PRIVATE_KEY env var is required.");
  process.exit(1);
}
const KING_PRIVATE_KEY = process.env.MINALIA_KING_PRIVATE_KEY;
if (!KING_PRIVATE_KEY) {
  console.error("MINALIA_KING_PRIVATE_KEY env var is required.");
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
  const deployerKey = PrivateKey.fromBase58(DEPLOYER_PRIVATE_KEY!);
  const deployerPub = deployerKey.toPublicKey();
  const kingKey = PrivateKey.fromBase58(KING_PRIVATE_KEY!);
  const kingPub = kingKey.toPublicKey();
  const aliceKey = PrivateKey.random();
  const alicePub = aliceKey.toPublicKey();
  const bobKey = PrivateKey.random();
  const bobPub = bobKey.toPublicKey();

  const ministerKeyPair = PrivateKey.random();
  const ministerPub = ministerKeyPair.toPublicKey();

  console.log("Deployer:       ", deployerPub.toBase58());
  console.log("King:           ", kingPub.toBase58());
  console.log("Alice (owner):  ", alicePub.toBase58());
  console.log("Bob (employee): ", bobPub.toBase58());
  console.log("Minister:       ", ministerPub.toBase58());
  console.log("Settle wait per tx:", SETTLE_MS / 1000, "s");

  const deployerClient = buildNodeClient(deployerKey, GRAPHQL_URL);
  await deployerClient.start();
  const kingClient = buildNodeClient(kingKey, GRAPHQL_URL);
  await kingClient.start();
  const ministerClient = buildNodeClient(ministerKeyPair, GRAPHQL_URL);
  await ministerClient.start();

  const registry = deployerClient.runtime.resolve("MinaliaUnitRegistry");
  const ministerDevs = ministerClient.runtime.resolve("MinaliaDevelopmentRegistry");
  const ministerJobs = ministerClient.runtime.resolve("MinaliaJobRegistry");
  const kingTreasury = kingClient.runtime.resolve("MinaliaTreasury");

  async function sendDeployer(label: string, build: () => Promise<unknown>) {
    console.log("[deployer]", label);
    const tx = await deployerClient.transaction(deployerPub, build as any);
    await tx.sign();
    await tx.send();
    await wait(SETTLE_MS);
  }
  async function sendKing(label: string, build: () => Promise<unknown>) {
    console.log("[king]", label);
    const tx = await kingClient.transaction(kingPub, build as any);
    await tx.sign();
    await tx.send();
    await wait(SETTLE_MS);
  }
  async function sendMinister(label: string, build: () => Promise<unknown>) {
    console.log("[minister]", label);
    const tx = await ministerClient.transaction(ministerPub, build as any);
    await tx.sign();
    await tx.send();
    await wait(SETTLE_MS);
  }

  async function getEmployment(empId: Field) {
    const e = await deployerClient.query.runtime.MinaliaJobRegistry.employments.get(empId);
    if (!e) return null;
    return {
      employee: e.employee.toBase58(),
      weeklyWageArkis: e.weeklyWageArkis.toString(),
      cycleBlocks: e.cycleBlocks.toString(),
      currentCycleN: e.currentCycleN.toString(),
      lastPayoutAt: e.lastPayoutAt.toString(),
      status: e.status.toString(),
      initialised: e.initialised.toBoolean(),
    };
  }
  async function getTreasuryBalance(key: TreasuryKey) {
    const b = await deployerClient.query.runtime.MinaliaTreasury.balances.get(key);
    return b ? b.toString() : "0";
  }
  async function blockHeight(): Promise<number> {
    const r = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ network { unproven { block { height } } } }" }),
    });
    const j: any = await r.json();
    return Number(j.data.network.unproven.block.height);
  }
  async function expect(label: string, actual: string, expected: string) {
    const pass = actual === expected;
    console.log("  ", pass ? "PASS" : "FAIL", label, "got=", actual, "expected=", expected);
    return pass;
  }

  let failures = 0;

  const TERRITORY_ID = Field(800001);
  const MINISTER_HASH = Field(800099);
  const UNIT_SLOT = UInt64.from(1);
  const UNIT_ID = unitIdFor(TERRITORY_ID, UNIT_SLOT);
  const FOUNDRY = UInt64.from(1);

  const WAGE = Balance.from(100);
  const CYCLE_BLOCKS = UInt64.from(3);            // small cadence so we can wait it out
  const SMALL_SEED = Balance.from(50);            // LESS than one wage — forces insufficient-treasury
  const TOPUP = Balance.from(10_000);

  const ministerVaultKey = TreasuryKey.fromMinister(MINISTER_HASH, ZARKIS_TOKEN_ID);
  const bobVaultKey = TreasuryKey.fromPlayer(bobPub, ZARKIS_TOKEN_ID);

  logStep("BOOTSTRAP: territory + unit + dev + UNDER-funded minister vault (50 < wage 100)");
  await sendDeployer("assignMinister", async () => {
    await registry.assignMinister(TERRITORY_ID, MINISTER_HASH, ministerPub);
  });
  await sendDeployer("registerUnit", async () => {
    await registry.registerUnit(TERRITORY_ID, UNIT_SLOT, alicePub, Bool(false));
  });
  await sendKing("setSupplyCap", async () => {
    await kingTreasury.setSupplyCap(ZARKIS_TOKEN_ID, Balance.from(1_000_000));
  });
  await sendKing("mint SMALL_SEED (50) into minister vault", async () => {
    await kingTreasury.mint(ministerVaultKey, SMALL_SEED);
  });
  const devSlot1 = UInt64.from(1);
  const devId1 = devIdFor(UNIT_ID, devSlot1);
  await sendMinister("registerDevelopment", async () => {
    await ministerDevs.registerDevelopment(UNIT_ID, devSlot1, FOUNDRY, alicePub);
  });
  const empId1 = employmentIdFor(devId1);
  if (!await expect("minister vault under-funded", await getTreasuryBalance(ministerVaultKey), "50")) failures++;

  logStep("CH1: hire Bob, wage 100, cadence 3 blocks");
  await sendMinister("startEmployment (wage=100, cycleBlocks=3)", async () => {
    await ministerJobs.startEmployment(UNIT_ID, devId1, bobPub, WAGE, CYCLE_BLOCKS);
  });
  const e1 = await getEmployment(empId1);
  if (!await expect("emp.cycleBlocks = 3", e1?.cycleBlocks ?? "null", "3")) failures++;
  if (!await expect("emp.status ACTIVE", e1?.status ?? "null", EMPLOYMENT_STATUS.ACTIVE.toString())) failures++;
  if (!await expect("emp.currentCycleN = 0", e1?.currentCycleN ?? "null", "0")) failures++;

  // Wait out the cadence so cycle-readiness is NOT the thing blocking us —
  // we want the INSUFFICIENT TREASURY assertion to be the cause of revert.
  logStep("CH2: wait past cadence, then payCycle with too-little treasury → must REVERT");
  console.log("  waiting ~80s for cadence window to clear...");
  await wait(80000);
  const bobBeforeInsuff = await getTreasuryBalance(bobVaultKey);
  const vaultBeforeInsuff = await getTreasuryBalance(ministerVaultKey);
  const e1BeforeInsuff = await getEmployment(empId1);
  await sendMinister("payCycle should REVERT (vault 50 < wage 100)", async () => {
    await ministerJobs.payCycle(devId1);
  });
  const e1AfterInsuff = await getEmployment(empId1);
  if (!await expect("Bob vault unchanged (no pay)", await getTreasuryBalance(bobVaultKey), bobBeforeInsuff)) failures++;
  if (!await expect("minister vault unchanged", await getTreasuryBalance(ministerVaultKey), vaultBeforeInsuff)) failures++;
  if (!await expect("cycleN NOT advanced on revert", e1AfterInsuff?.currentCycleN ?? "null", e1BeforeInsuff?.currentCycleN ?? "null")) failures++;
  if (!await expect("status still ACTIVE", e1AfterInsuff?.status ?? "null", EMPLOYMENT_STATUS.ACTIVE.toString())) failures++;

  logStep("CH3: top up vault, then payCycle → SUCCEEDS");
  await sendKing("mint TOPUP into minister vault", async () => {
    await kingTreasury.mint(ministerVaultKey, TOPUP);
  });
  const vaultBeforePay = Number(await getTreasuryBalance(ministerVaultKey));
  const bobBeforePay = Number(await getTreasuryBalance(bobVaultKey));
  await sendMinister("payCycle (funded) should succeed", async () => {
    await ministerJobs.payCycle(devId1);
  });
  if (!await expect("Bob vault +100", await getTreasuryBalance(bobVaultKey), (bobBeforePay + 100).toString())) failures++;
  if (!await expect("minister vault -100", await getTreasuryBalance(ministerVaultKey), (vaultBeforePay - 100).toString())) failures++;
  const e1AfterPay = await getEmployment(empId1);
  if (!await expect("cycleN = 1", e1AfterPay?.currentCycleN ?? "null", "1")) failures++;

  logStep("CH4: ANTI-REPLAY — immediate second payCycle (too soon) → must REVERT");
  const hNow = await blockHeight();
  console.log("  current height:", hNow, "lastPayoutAt:", e1AfterPay?.lastPayoutAt, "cadence:", e1AfterPay?.cycleBlocks);
  const bobBeforeTooSoon = await getTreasuryBalance(bobVaultKey);
  const e1BeforeTooSoon = await getEmployment(empId1);
  await sendMinister("payCycle again immediately should REVERT (too soon)", async () => {
    await ministerJobs.payCycle(devId1);
  });
  const e1AfterTooSoon = await getEmployment(empId1);
  if (!await expect("Bob vault unchanged (too soon)", await getTreasuryBalance(bobVaultKey), bobBeforeTooSoon)) failures++;
  if (!await expect("cycleN NOT advanced (too soon)", e1AfterTooSoon?.currentCycleN ?? "null", e1BeforeTooSoon?.currentCycleN ?? "null")) failures++;

  logStep("CH5: wait out cadence window, then payCycle → SUCCEEDS again");
  console.log("  waiting ~80s for cadence window to clear...");
  await wait(80000);
  const bobBeforePay2 = Number(await getTreasuryBalance(bobVaultKey));
  await sendMinister("payCycle after window should succeed", async () => {
    await ministerJobs.payCycle(devId1);
  });
  if (!await expect("Bob vault +100 (2nd real pay)", await getTreasuryBalance(bobVaultKey), (bobBeforePay2 + 100).toString())) failures++;
  const e1Final = await getEmployment(empId1);
  if (!await expect("cycleN = 2", e1Final?.currentCycleN ?? "null", "2")) failures++;

  logStep("SUMMARY");
  if (failures === 0) console.log("All assertions passed");
  else console.log(failures, "assertion(s) failed");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
