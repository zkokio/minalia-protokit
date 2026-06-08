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

const KING_PRIVATE_KEY = process.env.MINALIA_KING_PRIVATE_KEY;
const DEPLOYER_PRIVATE_KEY = process.env.MINALIA_DEPLOYER_PRIVATE_KEY;
if (!KING_PRIVATE_KEY || !DEPLOYER_PRIVATE_KEY) {
  console.error("MINALIA_KING_PRIVATE_KEY and MINALIA_DEPLOYER_PRIVATE_KEY env vars are both required.");
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
  const kingKey = PrivateKey.fromBase58(KING_PRIVATE_KEY!);
  const kingPub = kingKey.toPublicKey();
  const deployerKey = PrivateKey.fromBase58(DEPLOYER_PRIVATE_KEY!);
  const deployerPub = deployerKey.toPublicKey();

  // Generate a throwaway minister keypair for this test territory.
  // The minister signs chargeTax txs. In production, the minister's
  // private key for each district lives in minalia-keys.env, but for
  // tests we use a fresh random one to keep the test self-contained.
  const ministerSignerKey = PrivateKey.random();
  const ministerSignerPub = ministerSignerKey.toPublicKey();

  const playerKey = PrivateKey.random();
  const playerPub = playerKey.toPublicKey();

  console.log("King:", kingPub.toBase58());
  console.log("Deployer:", deployerPub.toBase58());
  console.log("Minister signer:", ministerSignerPub.toBase58());
  console.log("Player:", playerPub.toBase58());
  console.log("Settle wait per tx:", SETTLE_MS / 1000, "s");

  // Three clients, one per signer. King signs Treasury ops, deployer
  // signs UnitRegistry + setTaxConfig, minister signs chargeTax.
  const kingClient = buildNodeClient(kingKey, GRAPHQL_URL);
  await kingClient.start();
  const deployerClient = buildNodeClient(deployerKey, GRAPHQL_URL);
  await deployerClient.start();
  const ministerClient = buildNodeClient(ministerSignerKey, GRAPHQL_URL);
  await ministerClient.start();

  const kingTreasury = kingClient.runtime.resolve("MinaliaTreasury");
  const deployerRegistry = deployerClient.runtime.resolve("MinaliaUnitRegistry");
  const deployerTax = deployerClient.runtime.resolve("MinaliaTax");
  const ministerTax = ministerClient.runtime.resolve("MinaliaTax");

  const TERRITORY_ID = Field(700001);
  const MINISTER_HASH = Field(700099);
  const SLOT = UInt64.from(1);
  const UNIT_ID = unitIdFor(TERRITORY_ID, SLOT);

  const TAX_AMOUNT = Balance.from(30);
  const CYCLE_BLOCKS = UInt64.from(1);

  const playerVault = TreasuryKey.fromPlayer(playerPub, ZARKIS_TOKEN_ID);
  const ministerVault = TreasuryKey.fromMinister(MINISTER_HASH, ZARKIS_TOKEN_ID);

  async function sendKing(label: string, build: () => Promise<unknown>) {
    console.log("[king]", label);
    const tx = await kingClient.transaction(kingPub, build as any);
    await tx.sign();
    await tx.send();
    await wait(SETTLE_MS);
  }

  async function sendDeployer(label: string, build: () => Promise<unknown>) {
    console.log("[deployer]", label);
    const tx = await deployerClient.transaction(deployerPub, build as any);
    await tx.sign();
    await tx.send();
    await wait(SETTLE_MS);
  }

  async function sendMinister(label: string, build: () => Promise<unknown>) {
    console.log("[minister]", label);
    const tx = await ministerClient.transaction(ministerSignerPub, build as any);
    await tx.sign();
    await tx.send();
    await wait(SETTLE_MS);
  }

  async function getBalance(key: TreasuryKey): Promise<string> {
    const b = await kingClient.query.runtime.MinaliaTreasury.balances.get(key);
    return b?.toString() ?? "0";
  }

  async function getDebt(unitId: Field): Promise<string> {
    const d = await kingClient.query.runtime.MinaliaTax.debts.get(unitId);
    return d?.toString() ?? "0";
  }

  async function expect(label: string, actual: string, expected: string) {
    const pass = actual === expected;
    const symbol = pass ? "PASS" : "FAIL";
    console.log("  ", symbol, label, "got=", actual, "expected=", expected);
    return pass;
  }

  let failures = 0;

  logStep("SETUP: supply cap (king), bootstrap (deployer)");

  await sendKing("Treasury.setSupplyCap(ZARKIS, 10000)", async () => {
    await kingTreasury.setSupplyCap(ZARKIS_TOKEN_ID, Balance.from(10000));
  });

  await sendDeployer("UnitRegistry.assignMinister", async () => {
    await deployerRegistry.assignMinister(TERRITORY_ID, MINISTER_HASH, ministerSignerPub);
  });

  await sendDeployer("UnitRegistry.registerUnit slot 1, owner=Player", async () => {
    await deployerRegistry.registerUnit(TERRITORY_ID, SLOT, playerPub, Bool(false));
  });

  await sendDeployer("Tax.setTaxConfig(30 per 1 block)", async () => {
    await deployerTax.setTaxConfig(UNIT_ID, TAX_AMOUNT, CYCLE_BLOCKS);
  });

  logStep("TEST 1: Happy path - player can afford tax");

  await sendKing("mint 100 to player", async () => {
    await kingTreasury.mint(playerVault, Balance.from(100));
  });

  const balBeforeTax = await getBalance(playerVault);
  const minBeforeTax = await getBalance(ministerVault);
  console.log("  player balance before tax:", balBeforeTax);
  console.log("  minister balance before tax:", minBeforeTax);

  await sendMinister("Tax.chargeTax(unit)", async () => {
    await ministerTax.chargeTax(UNIT_ID);
  });

  const balAfterTax = await getBalance(playerVault);
  const minAfterTax = await getBalance(ministerVault);
  const debtAfter = await getDebt(UNIT_ID);
  console.log("  player balance after tax:", balAfterTax);
  console.log("  minister balance after tax:", minAfterTax);
  console.log("  debt after tax:", debtAfter);
  if (!await expect("player balance", balAfterTax, "70")) failures++;
  if (!await expect("minister balance", minAfterTax, "30")) failures++;
  if (!await expect("debt", debtAfter, "0")) failures++;

  logStep("TEST 2: Debt accrual - player cannot afford tax");

  await sendKing("burn 65 from player (leaves 5)", async () => {
    await kingTreasury.burn(playerVault, Balance.from(65));
  });

  const balBeforeT2 = await getBalance(playerVault);
  console.log("  player balance before T2:", balBeforeT2);

  await sendMinister("Tax.chargeTax(unit) should accrue", async () => {
    await ministerTax.chargeTax(UNIT_ID);
  });

  const balAfterT2 = await getBalance(playerVault);
  const minAfterT2 = await getBalance(ministerVault);
  const debtAfterT2 = await getDebt(UNIT_ID);
  console.log("  player balance after T2:", balAfterT2);
  console.log("  minister balance after T2:", minAfterT2);
  console.log("  debt after T2:", debtAfterT2);
  if (!await expect("player balance unchanged", balAfterT2, "5")) failures++;
  if (!await expect("minister balance unchanged", minAfterT2, "30")) failures++;
  if (!await expect("debt accrued to 30", debtAfterT2, "30")) failures++;

  logStep("TEST 3: Debt accumulates over consecutive failed cycles");

  await sendMinister("Tax.chargeTax(unit) should accrue again", async () => {
    await ministerTax.chargeTax(UNIT_ID);
  });

  const debtAfterT3 = await getDebt(UNIT_ID);
  const balAfterT3 = await getBalance(playerVault);
  console.log("  debt after T3:", debtAfterT3);
  if (!await expect("debt now 60", debtAfterT3, "60")) failures++;
  if (!await expect("player balance still 5", balAfterT3, "5")) failures++;

  logStep("TEST 4: Player gets funds, pays debt plus current cycle");

  await sendKing("mint 100 to player", async () => {
    await kingTreasury.mint(playerVault, Balance.from(100));
  });

  await sendMinister("Tax.chargeTax(unit) should pay 90", async () => {
    await ministerTax.chargeTax(UNIT_ID);
  });

  const balAfterT4 = await getBalance(playerVault);
  const minAfterT4 = await getBalance(ministerVault);
  const debtAfterT4 = await getDebt(UNIT_ID);
  console.log("  player balance after T4:", balAfterT4);
  console.log("  minister balance after T4:", minAfterT4);
  console.log("  debt after T4:", debtAfterT4);
  if (!await expect("player balance", balAfterT4, "15")) failures++;
  if (!await expect("minister balance", minAfterT4, "120")) failures++;
  if (!await expect("debt cleared", debtAfterT4, "0")) failures++;

  logStep("TEST 5: ATTACK - non-minister cannot chargeTax");

  const intruderKey = PrivateKey.random();
  const intruderPub = intruderKey.toPublicKey();
  const intruderClient = buildNodeClient(intruderKey, GRAPHQL_URL);
  await intruderClient.start();
  const intruderTax = intruderClient.runtime.resolve("MinaliaTax");

  await sendKing("mint 100 to player (top up)", async () => {
    await kingTreasury.mint(playerVault, Balance.from(100));
  });

  const balBeforeAttack = await getBalance(playerVault);
  const minBeforeAttack = await getBalance(ministerVault);

  // Intruder signs chargeTax. Should be rejected by assertMinisterOf.
  const intruderTx = await intruderClient.transaction(intruderPub, async () => {
    await intruderTax.chargeTax(UNIT_ID);
  });
  await intruderTx.sign();
  await intruderTx.send();
  await wait(SETTLE_MS);

  const balAfterAttack = await getBalance(playerVault);
  const minAfterAttack = await getBalance(ministerVault);
  console.log("  player balance unchanged:", balAfterAttack);
  console.log("  minister balance unchanged:", minAfterAttack);
  if (!await expect("intruder failed: player balance unchanged", balAfterAttack, balBeforeAttack)) failures++;
  if (!await expect("intruder failed: minister balance unchanged", minAfterAttack, minBeforeAttack)) failures++;

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
