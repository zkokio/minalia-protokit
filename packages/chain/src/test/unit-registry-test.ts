import { PrivateKey, UInt64, Field, Bool, Poseidon } from "o1js";
import { buildNodeClient } from "../core/environments/node.config";
import {
  unitIdFor,
  UNIT_EVENT_KIND,
} from "../runtime/modules/unitRegistry";

const GRAPHQL_URL = process.env.PROTOKIT_GRAPHQL_URL ?? "http://localhost:8080/graphql";
const SETTLE_MS = 10000;

const DEPLOYER_PRIVATE_KEY = process.env.MINALIA_DEPLOYER_PRIVATE_KEY;
if (!DEPLOYER_PRIVATE_KEY) {
  console.error("MINALIA_DEPLOYER_PRIVATE_KEY env var is required.");
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
  const intruderKey = PrivateKey.random();
  const intruderPub = intruderKey.toPublicKey();
  const playerKey = PrivateKey.random();
  const playerPub = playerKey.toPublicKey();
  const player2Key = PrivateKey.random();
  const player2Pub = player2Key.toPublicKey();
  const ministerKeyPair = PrivateKey.random();
  const ministerPub = ministerKeyPair.toPublicKey();

  console.log("Deployer:", deployerPub.toBase58());
  console.log("Intruder:", intruderPub.toBase58());
  console.log("Player 1:", playerPub.toBase58());
  console.log("Player 2:", player2Pub.toBase58());
  console.log("Minister:", ministerPub.toBase58());
  console.log("Settle wait per tx:", SETTLE_MS / 1000, "s");

  const authClient = buildNodeClient(deployerKey, GRAPHQL_URL);
  await authClient.start();
  const intruderClient = buildNodeClient(intruderKey, GRAPHQL_URL);
  await intruderClient.start();

  const authRegistry = authClient.runtime.resolve("MinaliaUnitRegistry");
  const intruderRegistry = intruderClient.runtime.resolve("MinaliaUnitRegistry");

  const TERRITORY_ID = Field(900001);
  const MINISTER_HASH = Field(900099);
  const SLOT_1 = UInt64.from(1);
  const SLOT_2 = UInt64.from(2);

  async function sendAuth(label: string, build: () => Promise<unknown>) {
    console.log("[deployer]", label);
    const tx = await authClient.transaction(deployerPub, build as any);
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

  async function getUnit(unitId: Field) {
    const u = await authClient.query.runtime.MinaliaUnitRegistry.units.get(unitId);
    if (!u) return null;
    return {
      owner: u.owner.toBase58(),
      minister: u.minister.toString(),
      territoryId: u.territoryId.toString(),
      slot: u.slot.toString(),
      isMinisterHeld: u.isMinisterHeld.toBoolean(),
      initialised: u.initialised.toBoolean(),
    };
  }

  async function getTerritory(territoryId: Field) {
    const t = await authClient.query.runtime.MinaliaUnitRegistry.territories.get(territoryId);
    if (!t) return null;
    return {
      minister: t.minister.toString(),
      ministerKey: t.ministerKey.toBase58(),
      initialised: t.initialised.toBoolean(),
    };
  }

  async function expect(label: string, actual: string, expected: string) {
    const pass = actual === expected;
    const symbol = pass ? "PASS" : "FAIL";
    console.log("  ", symbol, label, "got=", actual, "expected=", expected);
    return pass;
  }

  let failures = 0;

  logStep("TEST 1: assignMinister with ministerKey");
  await sendAuth("assignMinister", async () => {
    await authRegistry.assignMinister(TERRITORY_ID, MINISTER_HASH, ministerPub);
  });
  const tState = await getTerritory(TERRITORY_ID);
  console.log("  territory state:", tState);
  if (!await expect("territory.minister", tState?.minister ?? "null", MINISTER_HASH.toString())) failures++;
  if (!await expect("territory.ministerKey", tState?.ministerKey ?? "null", ministerPub.toBase58())) failures++;
  if (!await expect("territory.initialised", String(tState?.initialised ?? false), "true")) failures++;

  logStep("TEST 2: registerUnit slot 1, owner=Player1");
  await sendAuth("registerUnit", async () => {
    await authRegistry.registerUnit(TERRITORY_ID, SLOT_1, playerPub, Bool(false));
  });
  const unitId1 = unitIdFor(TERRITORY_ID, SLOT_1);
  const u1 = await getUnit(unitId1);
  console.log("  unit:", u1);
  if (!await expect("unit.owner", u1?.owner ?? "null", playerPub.toBase58())) failures++;
  if (!await expect("unit.minister", u1?.minister ?? "null", MINISTER_HASH.toString())) failures++;
  if (!await expect("unit.territoryId", u1?.territoryId ?? "null", TERRITORY_ID.toString())) failures++;
  if (!await expect("unit.slot", u1?.slot ?? "null", "1")) failures++;
  if (!await expect("unit.isMinisterHeld", String(u1?.isMinisterHeld ?? "null"), "false")) failures++;
  if (!await expect("unit.initialised", String(u1?.initialised ?? "null"), "true")) failures++;

  logStep("TEST 3: registerUnit slot 2, isMinisterHeld=true");
  await sendAuth("registerUnit minister-held", async () => {
    await authRegistry.registerUnit(TERRITORY_ID, SLOT_2, playerPub, Bool(true));
  });
  const unitId2 = unitIdFor(TERRITORY_ID, SLOT_2);
  const u2 = await getUnit(unitId2);
  console.log("  unit:", u2);
  if (!await expect("unit.isMinisterHeld", String(u2?.isMinisterHeld ?? "null"), "true")) failures++;

  logStep("TEST 4: transferUnit slot 1 to Player2");
  await sendAuth("transferUnit", async () => {
    await authRegistry.transferUnit(unitId1, player2Pub);
  });
  const u1after = await getUnit(unitId1);
  console.log("  unit after transfer:", u1after);
  if (!await expect("unit.owner after transfer", u1after?.owner ?? "null", player2Pub.toBase58())) failures++;
  if (!await expect("unit.isMinisterHeld after transfer", String(u1after?.isMinisterHeld ?? "null"), "false")) failures++;
  if (!await expect("unit.minister preserved", u1after?.minister ?? "null", MINISTER_HASH.toString())) failures++;

  logStep("TEST 5: intruder rejected from registerUnit");
  const SLOT_3 = UInt64.from(3);
  const unitId3 = unitIdFor(TERRITORY_ID, SLOT_3);
  await sendIntruder("registerUnit by intruder should fail", async () => {
    await intruderRegistry.registerUnit(TERRITORY_ID, SLOT_3, intruderPub, Bool(false));
  });
  const afterIntruder = await getUnit(unitId3);
  console.log("  unit at slot 3 after intruder attempt:", afterIntruder);
  const intruderRejected =
    afterIntruder === null || afterIntruder.initialised === false;
  if (!await expect("intruder did NOT create unit", String(intruderRejected), "true")) failures++;

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
