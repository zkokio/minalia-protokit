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
  const intruderKey = PrivateKey.random();
  const intruderPub = intruderKey.toPublicKey();

  // Throwaway minister keypair, registered to the test territory at bootstrap.
  const ministerKeyPair = PrivateKey.random();
  const ministerPub = ministerKeyPair.toPublicKey();

  // Throwaway second-minister keypair for attack tests (signs as minister of
  // a DIFFERENT territory, should not be able to drive ops on our test unit).
  const otherMinisterKey = PrivateKey.random();
  const otherMinisterPub = otherMinisterKey.toPublicKey();

  console.log("Deployer:       ", deployerPub.toBase58());
  console.log("King:           ", kingPub.toBase58());
  console.log("Alice (owner):  ", alicePub.toBase58());
  console.log("Bob (employee): ", bobPub.toBase58());
  console.log("Intruder:       ", intruderPub.toBase58());
  console.log("Minister:       ", ministerPub.toBase58());
  console.log("Other Minister: ", otherMinisterPub.toBase58());
  console.log("Settle wait per tx:", SETTLE_MS / 1000, "s");

  const deployerClient = buildNodeClient(deployerKey, GRAPHQL_URL);
  await deployerClient.start();
  const kingClient = buildNodeClient(kingKey, GRAPHQL_URL);
  await kingClient.start();
  const ministerClient = buildNodeClient(ministerKeyPair, GRAPHQL_URL);
  await ministerClient.start();
  const otherMinisterClient = buildNodeClient(otherMinisterKey, GRAPHQL_URL);
  await otherMinisterClient.start();
  const intruderClient = buildNodeClient(intruderKey, GRAPHQL_URL);
  await intruderClient.start();
  const bobClient = buildNodeClient(bobKey, GRAPHQL_URL);
  await bobClient.start();

  const registry = deployerClient.runtime.resolve("MinaliaUnitRegistry");
  const ministerDevs = ministerClient.runtime.resolve("MinaliaDevelopmentRegistry");
  const ministerJobs = ministerClient.runtime.resolve("MinaliaJobRegistry");
  const otherMinisterJobs = otherMinisterClient.runtime.resolve("MinaliaJobRegistry");
  const intruderJobs = intruderClient.runtime.resolve("MinaliaJobRegistry");
  const bobJobs = bobClient.runtime.resolve("MinaliaJobRegistry");
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
  async function sendOtherMinister(label: string, build: () => Promise<unknown>) {
    console.log("[other-minister]", label);
    const tx = await otherMinisterClient.transaction(otherMinisterPub, build as any);
    await tx.sign();
    await tx.send();
    await wait(SETTLE_MS);
  }
  async function sendIntruder(label: string, build: () => Promise<unknown>) {
    console.log("[intruder]", label);
    const tx = await intruderClient.transaction(intruderPub, build as any);
    await tx.sign();
    await tx.send();
    await wait(SETTLE_MS);
  }
  async function sendBob(label: string, build: () => Promise<unknown>) {
    console.log("[bob]", label);
    const tx = await bobClient.transaction(bobPub, build as any);
    await tx.sign();
    await tx.send();
    await wait(SETTLE_MS);
  }

  async function getEmployment(empId: Field) {
    const e = await deployerClient.query.runtime.MinaliaJobRegistry.employments.get(empId);
    if (!e) return null;
    return {
      unitId: e.unitId.toString(),
      devId: e.devId.toString(),
      employee: e.employee.toBase58(),
      weeklyWageArkis: e.weeklyWageArkis.toString(),
      startedAt: e.startedAt.toString(),
      currentCycleN: e.currentCycleN.toString(),
      lastPayoutAt: e.lastPayoutAt.toString(),
      status: e.status.toString(),
      initialised: e.initialised.toBoolean(),
    };
  }

  async function getDev(devId: Field) {
    const d = await deployerClient.query.runtime.MinaliaDevelopmentRegistry.developments.get(devId);
    if (!d) return null;
    return {
      manager: d.manager.toBase58(),
      architect: d.architect.toBase58(),
    };
  }

  async function getTreasuryBalance(key: TreasuryKey) {
    const b = await deployerClient.query.runtime.MinaliaTreasury.balances.get(key);
    return b ? b.toString() : "0";
  }

  async function expect(label: string, actual: string, expected: string) {
    const pass = actual === expected;
    const symbol = pass ? "PASS" : "FAIL";
    console.log("  ", symbol, label, "got=", actual, "expected=", expected);
    return pass;
  }

  let failures = 0;

  const TERRITORY_ID = Field(700001);
  const MINISTER_HASH = Field(700099);
  const OTHER_TERRITORY_ID = Field(700002);
  const OTHER_MINISTER_HASH = Field(700199);
  const UNIT_SLOT = UInt64.from(1);
  const UNIT_ID = unitIdFor(TERRITORY_ID, UNIT_SLOT);

  const FOUNDRY = UInt64.from(1);
  const WAGE = Balance.from(100);
  const TREASURY_SEED = Balance.from(10_000);

  // Treasury keys for balance assertions.
  const ministerVaultKey = TreasuryKey.fromMinister(MINISTER_HASH, ZARKIS_TOKEN_ID);
  const bobVaultKey = TreasuryKey.fromPlayer(bobPub, ZARKIS_TOKEN_ID);

  logStep("BOOTSTRAP: register territories + unit + dev + fund minister vault");

  await sendDeployer("UnitRegistry.assignMinister (test territory)", async () => {
    await registry.assignMinister(TERRITORY_ID, MINISTER_HASH, ministerPub);
  });
  await sendDeployer("UnitRegistry.assignMinister (other territory)", async () => {
    await registry.assignMinister(OTHER_TERRITORY_ID, OTHER_MINISTER_HASH, otherMinisterPub);
  });
  await sendDeployer("UnitRegistry.registerUnit slot 1 owner=Alice", async () => {
    await registry.registerUnit(TERRITORY_ID, UNIT_SLOT, alicePub, Bool(false));
  });

  // Set the supply cap and mint ZARKIS into the minister's vault so payCycle
  // has actual funds to move. Authority for these is the king.
  await sendKing("Treasury.setSupplyCap", async () => {
    await kingTreasury.setSupplyCap(ZARKIS_TOKEN_ID, Balance.from(1_000_000));
  });
  await sendKing("Treasury.mint into minister vault", async () => {
    await kingTreasury.mint(ministerVaultKey, TREASURY_SEED);
  });

  const devSlot1 = UInt64.from(1);
  const devId1 = devIdFor(UNIT_ID, devSlot1);
  await sendMinister("DevRegistry.registerDevelopment", async () => {
    await ministerDevs.registerDevelopment(UNIT_ID, devSlot1, FOUNDRY, alicePub);
  });

  // Confirm minister vault has the seed.
  const ministerBalAtBoot = await getTreasuryBalance(ministerVaultKey);
  if (!await expect("minister vault funded", ministerBalAtBoot, "10000")) failures++;

  logStep("JH1: minister starts employment — Bob employed on devId1");
  const empId1 = employmentIdFor(devId1);

  await sendMinister("JobRegistry.startEmployment", async () => {
    await ministerJobs.startEmployment(UNIT_ID, devId1, bobPub, WAGE);
  });

  const e1 = await getEmployment(empId1);
  console.log("  employment:", e1);
  if (!await expect("emp.unitId", e1?.unitId ?? "null", UNIT_ID.toString())) failures++;
  if (!await expect("emp.devId", e1?.devId ?? "null", devId1.toString())) failures++;
  if (!await expect("emp.employee = Bob", e1?.employee ?? "null", bobPub.toBase58())) failures++;
  if (!await expect("emp.weeklyWageArkis = 100", e1?.weeklyWageArkis ?? "null", "100")) failures++;
  if (!await expect("emp.currentCycleN = 0", e1?.currentCycleN ?? "null", "0")) failures++;
  if (!await expect("emp.status = ACTIVE", e1?.status ?? "null", EMPLOYMENT_STATUS.ACTIVE.toString())) failures++;
  if (!await expect("emp.initialised", String(e1?.initialised ?? "null"), "true")) failures++;

  // startEmployment should also have synced the dev's manager to Bob.
  const d1 = await getDev(devId1);
  if (!await expect("dev.manager = Bob", d1?.manager ?? "null", bobPub.toBase58())) failures++;

  logStep("JH2: minister pays a wage cycle — Bob receives 100, minister vault -100");
  const ministerBefore = await getTreasuryBalance(ministerVaultKey);
  const bobBefore = await getTreasuryBalance(bobVaultKey);

  await sendMinister("JobRegistry.payCycle", async () => {
    await ministerJobs.payCycle(devId1);
  });

  const ministerAfter = await getTreasuryBalance(ministerVaultKey);
  const bobAfter = await getTreasuryBalance(bobVaultKey);
  if (!await expect("minister vault -100", ministerAfter, (Number(ministerBefore) - 100).toString())) failures++;
  if (!await expect("Bob vault +100", bobAfter, (Number(bobBefore) + 100).toString())) failures++;

  const e1AfterPay = await getEmployment(empId1);
  if (!await expect("currentCycleN = 1", e1AfterPay?.currentCycleN ?? "null", "1")) failures++;
  if (!await expect("status still ACTIVE", e1AfterPay?.status ?? "null", EMPLOYMENT_STATUS.ACTIVE.toString())) failures++;

  logStep("JH3: minister pays a second cycle — counter advances");
  await sendMinister("JobRegistry.payCycle (2nd)", async () => {
    await ministerJobs.payCycle(devId1);
  });
  const e1AfterPay2 = await getEmployment(empId1);
  if (!await expect("currentCycleN = 2", e1AfterPay2?.currentCycleN ?? "null", "2")) failures++;

  logStep("JH4: minister terminates — status flips, dev.manager cleared");
  await sendMinister("JobRegistry.terminate", async () => {
    await ministerJobs.terminate(devId1);
  });
  const e1Terminated = await getEmployment(empId1);
  if (!await expect("status = TERMINATED", e1Terminated?.status ?? "null", EMPLOYMENT_STATUS.TERMINATED.toString())) failures++;
  const d1AfterTerm = await getDev(devId1);
  if (!await expect("dev.manager cleared (empty pubkey)", d1AfterTerm?.manager ?? "null", "B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyBQL9TDb3nvBG")) failures++;

  logStep("JH5: cannot pay a terminated employment");
  const bobBeforeNoPay = await getTreasuryBalance(bobVaultKey);
  await sendMinister("JobRegistry.payCycle on terminated should fail", async () => {
    await ministerJobs.payCycle(devId1);
  });
  const bobAfterNoPay = await getTreasuryBalance(bobVaultKey);
  if (!await expect("Bob vault unchanged", bobAfterNoPay, bobBeforeNoPay)) failures++;

  logStep("JH6: minister can re-hire after termination");
  await sendMinister("JobRegistry.startEmployment (rehire)", async () => {
    await ministerJobs.startEmployment(UNIT_ID, devId1, bobPub, WAGE);
  });
  const e1Rehired = await getEmployment(empId1);
  if (!await expect("status = ACTIVE after rehire", e1Rehired?.status ?? "null", EMPLOYMENT_STATUS.ACTIVE.toString())) failures++;
  if (!await expect("currentCycleN reset to 0", e1Rehired?.currentCycleN ?? "null", "0")) failures++;

  logStep("JA1: ATTACK - intruder startEmployment");
  const devSlot2 = UInt64.from(2);
  const devId2 = devIdFor(UNIT_ID, devSlot2);
  await sendMinister("DevRegistry.registerDevelopment slot 2 (for attack tests)", async () => {
    await ministerDevs.registerDevelopment(UNIT_ID, devSlot2, FOUNDRY, alicePub);
  });
  const empId2 = employmentIdFor(devId2);

  await sendIntruder("intruder startEmployment should fail", async () => {
    await intruderJobs.startEmployment(UNIT_ID, devId2, intruderPub, WAGE);
  });
  const empId2State = await getEmployment(empId2);
  if (!await expect("no employment created by intruder", String(empId2State?.initialised ?? "false"), "false")) failures++;

  logStep("JA2: ATTACK - intruder payCycle on active employment");
  const bobBeforeAttack = await getTreasuryBalance(bobVaultKey);
  await sendIntruder("intruder payCycle should fail", async () => {
    await intruderJobs.payCycle(devId1);
  });
  const bobAfterAttack = await getTreasuryBalance(bobVaultKey);
  if (!await expect("Bob vault unchanged by intruder", bobAfterAttack, bobBeforeAttack)) failures++;

  logStep("JA3: ATTACK - intruder terminate");
  await sendIntruder("intruder terminate should fail", async () => {
    await intruderJobs.terminate(devId1);
  });
  const e1AfterIntruderTerm = await getEmployment(empId1);
  if (!await expect("status still ACTIVE", e1AfterIntruderTerm?.status ?? "null", EMPLOYMENT_STATUS.ACTIVE.toString())) failures++;

  logStep("JA4: ATTACK - employee (Bob) tries to payCycle themselves");
  const bobBeforeSelfPay = await getTreasuryBalance(bobVaultKey);
  await sendBob("Bob payCycle should fail (employee is not minister)", async () => {
    await bobJobs.payCycle(devId1);
  });
  const bobAfterSelfPay = await getTreasuryBalance(bobVaultKey);
  if (!await expect("Bob vault unchanged by self-pay", bobAfterSelfPay, bobBeforeSelfPay)) failures++;

  logStep("JA5: ATTACK - other-territory minister tries ops on our unit");
  const bobBeforeXMin = await getTreasuryBalance(bobVaultKey);
  await sendOtherMinister("other minister payCycle should fail (wrong territory)", async () => {
    await otherMinisterJobs.payCycle(devId1);
  });
  const bobAfterXMin = await getTreasuryBalance(bobVaultKey);
  if (!await expect("Bob vault unchanged by cross-territory minister", bobAfterXMin, bobBeforeXMin)) failures++;

  await sendOtherMinister("other minister terminate should fail", async () => {
    await otherMinisterJobs.terminate(devId1);
  });
  const e1AfterXMin = await getEmployment(empId1);
  if (!await expect("status still ACTIVE after cross-territory terminate", e1AfterXMin?.status ?? "null", EMPLOYMENT_STATUS.ACTIVE.toString())) failures++;

  logStep("JA6: ATTACK - double-hire on already-active employment");
  const e1BeforeDouble = await getEmployment(empId1);
  await sendMinister("startEmployment on already-active dev should fail", async () => {
    await ministerJobs.startEmployment(UNIT_ID, devId1, alicePub, WAGE);
  });
  const e1AfterDouble = await getEmployment(empId1);
  if (!await expect("employee unchanged", e1AfterDouble?.employee ?? "null", e1BeforeDouble?.employee ?? "null")) failures++;
  if (!await expect("currentCycleN unchanged", e1AfterDouble?.currentCycleN ?? "null", e1BeforeDouble?.currentCycleN ?? "null")) failures++;

  logStep("JA7: ATTACK - hire on a non-existent dev");
  const fakeDevId = Field(999999);
  const fakeEmpId = employmentIdFor(fakeDevId);
  await sendMinister("startEmployment on fake dev should fail", async () => {
    await ministerJobs.startEmployment(UNIT_ID, fakeDevId, bobPub, WAGE);
  });
  const fakeEmpState = await getEmployment(fakeEmpId);
  if (!await expect("no employment created for fake dev", String(fakeEmpState?.initialised ?? "false"), "false")) failures++;

  logStep("JA8: ATTACK - hire claiming the dev is on the wrong unit");
  const wrongUnitId = unitIdFor(TERRITORY_ID, UInt64.from(99));
  await sendMinister("startEmployment claiming dev1 on wrong unit should fail", async () => {
    await ministerJobs.startEmployment(wrongUnitId, devId1, bobPub, WAGE);
  });
  const e1AfterWrongUnit = await getEmployment(empId1);
  if (!await expect("emp1 employee unchanged after wrong-unit hire attempt", e1AfterWrongUnit?.employee ?? "null", bobPub.toBase58())) failures++;

  logStep("SUMMARY");
  if (failures === 0) {
    console.log("All assertions passed");
  } else {
    console.log(failures, "assertion(s) failed");
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
