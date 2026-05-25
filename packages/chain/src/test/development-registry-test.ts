import { PrivateKey, UInt64, Field, Bool, Poseidon } from "o1js";
import { Balance } from "@proto-kit/library";
import { buildNodeClient } from "../core/environments/node.config";
import { unitIdFor } from "../runtime/modules/unitRegistry";
import { devIdFor } from "../runtime/modules/developmentRegistry";

const GRAPHQL_URL = process.env.PROTOKIT_GRAPHQL_URL ?? "http://localhost:8080/graphql";
const SETTLE_MS = 10000;

async function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function logStep(label: string) {
  console.log("\n" + "=".repeat(60));
  console.log(label);
  console.log("=".repeat(60));
}

async function main() {
  const authorityKey = PrivateKey.random();
  const authorityPub = authorityKey.toPublicKey();
  const aliceKey = PrivateKey.random();
  const alicePub = aliceKey.toPublicKey();
  const bobKey = PrivateKey.random();
  const bobPub = bobKey.toPublicKey();
  const intruderKey = PrivateKey.random();
  const intruderPub = intruderKey.toPublicKey();

  console.log("Authority:", authorityPub.toBase58());
  console.log("Alice:    ", alicePub.toBase58());
  console.log("Bob:      ", bobPub.toBase58());
  console.log("Intruder: ", intruderPub.toBase58());
  console.log(`Settle wait per tx: ${SETTLE_MS / 1000}s`);

  const authClient = buildNodeClient(authorityKey, GRAPHQL_URL);
  await authClient.start();
  const intruderClient = buildNodeClient(intruderKey, GRAPHQL_URL);
  await intruderClient.start();

  const registry = authClient.runtime.resolve("MinaliaUnitRegistry");
  const devs = authClient.runtime.resolve("MinaliaDevelopmentRegistry");
  const intruderDevs = intruderClient.runtime.resolve("MinaliaDevelopmentRegistry");

  // Helpers
  async function sendAuth(label: string, build: () => Promise<unknown>) {
    console.log(`→ [auth] ${label}`);
    const tx = await authClient.transaction(authorityPub, build as any);
    await tx.sign();
    await tx.send();
    await wait(SETTLE_MS);
  }
  async function sendIntruder(label: string, build: () => Promise<unknown>) {
    console.log(`→ [intruder] ${label}`);
    const tx = await intruderClient.transaction(intruderPub, build as any);
    await tx.sign();
    await tx.send();
    await wait(SETTLE_MS);
  }

  async function getDev(devId: Field) {
    const d = await authClient.query.runtime.MinaliaDevelopmentRegistry.developments.get(devId);
    if (!d) return null;
    return {
      unitId: d.unitId.toString(),
      devSlot: d.devSlot.toString(),
      devType: d.devType.toString(),
      upgradeLevel: d.upgradeLevel.toString(),
      architect: d.architect.toBase58(),
      manager: d.manager.toBase58(),
      initialised: d.initialised.toBoolean(),
    };
  }

  async function expect(label: string, actual: string, expected: string) {
    const pass = actual === expected;
    const symbol = pass ? "✓" : "✗";
    console.log(`  ${symbol} ${label}: got=${actual}, expected=${expected}`);
    return pass;
  }

  let failures = 0;

  const TERRITORY_ID = Field(600001);
  const MINISTER_HASH = Field(600099);
  const UNIT_SLOT = UInt64.from(1);
  const UNIT_ID = unitIdFor(TERRITORY_ID, UNIT_SLOT);

  // Dev type slugs (we agreed off-chain map). Numbers arbitrary for the test.
  const FOUNDRY = UInt64.from(1);
  const MARKET = UInt64.from(2);

  // ── BOOTSTRAP ──────────────────────────────────────────────────
  logStep("BOOTSTRAP: register territory + a unit; set DevRegistry authority");  await sendAuth("UnitRegistry.assignMinister", async () => {
    await registry.assignMinister(TERRITORY_ID, MINISTER_HASH);
  });
  await sendAuth("UnitRegistry.registerUnit slot 1 (owner = Alice)", async () => {
    await registry.registerUnit(TERRITORY_ID, UNIT_SLOT, alicePub, Bool(false));
  });
  await sendAuth("DevRegistry.setAuthority", async () => {
    await devs.setAuthority(authorityPub);
  });

  // ── DH1: register a dev ────────────────────────────────────────
  logStep("DH1: register a Foundry on the unit at devSlot 1, architect = Alice");
  const devSlot1 = UInt64.from(1);
  const devId1 = devIdFor(UNIT_ID, devSlot1);

  await sendAuth("DevRegistry.registerDevelopment", async () => {
    await devs.registerDevelopment(UNIT_ID, devSlot1, FOUNDRY, alicePub);
  });

  const d1 = await getDev(devId1);
  console.log("  dev:", d1);
  if (!await expect("dev.unitId", d1?.unitId ?? "null", UNIT_ID.toString())) failures++;
  if (!await expect("dev.devSlot", d1?.devSlot ?? "null", "1")) failures++;
  if (!await expect("dev.devType (Foundry=1)", d1?.devType ?? "null", "1")) failures++;
  if (!await expect("dev.upgradeLevel = 1", d1?.upgradeLevel ?? "null", "1")) failures++;
  if (!await expect("dev.architect = Alice", d1?.architect ?? "null", alicePub.toBase58())) failures++;
  if (!await expect("dev.initialised = true", String(d1?.initialised ?? "null"), "true")) failures++;

  // ── DH2: upgrade the dev ───────────────────────────────────────
  logStep("DH2: upgrade dev to level 2");
  await sendAuth("DevRegistry.upgradeDevelopment(dev1)", async () => {
    await devs.upgradeDevelopment(devId1);
  });
  const d1u = await getDev(devId1);
  if (!await expect("dev.upgradeLevel = 2", d1u?.upgradeLevel ?? "null", "2")) failures++;
  // Other fields should be unchanged
  if (!await expect("architect preserved", d1u?.architect ?? "null", alicePub.toBase58())) failures++;

  // ── DH3: assign manager (Bob) ──────────────────────────────────
  logStep("DH3: assign Bob as manager");
  await sendAuth("DevRegistry.assignManager(dev1, Bob)", async () => {
    await devs.assignManager(devId1, bobPub);
  });
  const d1m = await getDev(devId1);
  if (!await expect("dev.manager = Bob", d1m?.manager ?? "null", bobPub.toBase58())) failures++;
  if (!await expect("upgradeLevel still 2", d1m?.upgradeLevel ?? "null", "2")) failures++;

  // ── DH4: transfer architect (Alice -> Bob) ─────────────────────
  logStep("DH4: transfer architect from Alice to Bob");
  await sendAuth("DevRegistry.transferArchitect(dev1, Bob)", async () => {
    await devs.transferArchitect(devId1, bobPub);
  });
  const d1a = await getDev(devId1);
  if (!await expect("dev.architect = Bob", d1a?.architect ?? "null", bobPub.toBase58())) failures++;
  // Manager already Bob from DH3 — both fields can be Bob, that's fine
  if (!await expect("dev.manager still Bob", d1a?.manager ?? "null", bobPub.toBase58())) failures++;

  // ── DH5: register a second dev on slot 2 of the same unit ──────
  logStep("DH5: register a Market on devSlot 2 of the same unit");
  const devSlot2 = UInt64.from(2);
  const devId2 = devIdFor(UNIT_ID, devSlot2);
  await sendAuth("DevRegistry.registerDevelopment(slot 2, Market, Alice)", async () => {
    await devs.registerDevelopment(UNIT_ID, devSlot2, MARKET, alicePub);
  });
  const d2 = await getDev(devId2);
  if (!await expect("slot 2 dev exists", String(d2?.initialised ?? "null"), "true")) failures++;
  if (!await expect("slot 2 devType (Market=2)", d2?.devType ?? "null", "2")) failures++;
  // Slot 1 dev should be unaffected by slot 2 registration
  const d1after2 = await getDev(devId1);
  if (!await expect("slot 1 dev still has architect Bob", d1after2?.architect ?? "null", bobPub.toBase58())) failures++;

  // ── DA1: intruder can't register ───────────────────────────────
  logStep("DA1: ATTACK — intruder registerDevelopment");
  const devSlot3 = UInt64.from(3);
  const devId3 = devIdFor(UNIT_ID, devSlot3);
  await sendIntruder("intruder registerDevelopment(slot 3) (should fail)", async () => {
    await intruderDevs.registerDevelopment(UNIT_ID, devSlot3, FOUNDRY, intruderPub);
  });
  const d3 = await getDev(devId3);
  if (!await expect("slot 3 still empty", String(d3?.initialised ?? "false"), "false")) failures++;

  // ── DA2: intruder can't upgrade ────────────────────────────────
  logStep("DA2: ATTACK — intruder upgradeDevelopment");
  // Read the current level of dev1 (currently 2 from DH2)
  const beforeLevel = (await getDev(devId1))?.upgradeLevel ?? "null";
  await sendIntruder("intruder upgrade dev1 (should fail)", async () => {
    await intruderDevs.upgradeDevelopment(devId1);
  });
  const afterLevel = (await getDev(devId1))?.upgradeLevel ?? "null";
  if (!await expect("dev1 level unchanged", afterLevel, beforeLevel)) failures++;

  // ── DA3: intruder can't assign manager ─────────────────────────
  logStep("DA3: ATTACK — intruder assignManager");
  await sendIntruder("intruder assignManager(dev1, intruder) (should fail)", async () => {
    await intruderDevs.assignManager(devId1, intruderPub);
  });
  const d1m_check = await getDev(devId1);
  if (!await expect("manager NOT intruder", d1m_check?.manager ?? "null", bobPub.toBase58())) failures++;

  // ── DA4: intruder can't transfer architect ─────────────────────
  logStep("DA4: ATTACK — intruder transferArchitect");
  await sendIntruder("intruder transferArchitect(dev1, intruder) (should fail)", async () => {
    await intruderDevs.transferArchitect(devId1, intruderPub);
  });
  const d1a_check = await getDev(devId1);
  if (!await expect("architect NOT intruder", d1a_check?.architect ?? "null", bobPub.toBase58())) failures++;

  // ── DA5: register on a non-existent unit ───────────────────────
  logStep("DA5: ATTACK — register on unit that doesn't exist");
  const fakeUnitId = Field(999999);
  const fakeDevId = devIdFor(fakeUnitId, UInt64.from(1));
  await sendAuth("authority registerDevelopment on fake unit (should fail)", async () => {
    await devs.registerDevelopment(fakeUnitId, UInt64.from(1), FOUNDRY, alicePub);
  });
  const fakeDev = await getDev(fakeDevId);
  if (!await expect("no dev created on fake unit", String(fakeDev?.initialised ?? "false"), "false")) failures++;

  // ── DA6: register on already-occupied slot ─────────────────────
  logStep("DA6: ATTACK — register on slot 1, already taken");
  // Snapshot dev1 state
  const d1Before = await getDev(devId1);
  await sendAuth("authority registerDevelopment on occupied slot 1 (should fail)", async () => {
    await devs.registerDevelopment(UNIT_ID, devSlot1, MARKET, alicePub);
  });
  const d1After = await getDev(devId1);
  // The existing dev should be unchanged — devType still Foundry, not Market
  if (!await expect("dev1 devType still Foundry", d1After?.devType ?? "null", "1")) failures++;
  if (!await expect("dev1 architect still Bob (unchanged)", d1After?.architect ?? "null", d1Before?.architect ?? "null")) failures++;

  // ── DA7: upgrade an empty slot ─────────────────────────────────
  logStep("DA7: ATTACK — upgrade a slot that has no dev");
  const emptyDevId = devIdFor(UNIT_ID, UInt64.from(5));
  await sendAuth("authority upgradeDevelopment on empty slot 5 (should fail)", async () => {
    await devs.upgradeDevelopment(emptyDevId);
  });
  const stillEmpty = await getDev(emptyDevId);
  if (!await expect("slot 5 still empty (no dev created by failed upgrade)", String(stillEmpty?.initialised ?? "false"), "false")) failures++;

  // ── DA8: register at slot exceeding max ────────────────────────
  logStep("DA8: ATTACK — register at devSlot 99 (max is 15)");
  const farSlot = UInt64.from(99);
  const farDevId = devIdFor(UNIT_ID, farSlot);
  await sendAuth("authority registerDevelopment slot 99 (should fail)", async () => {
    await devs.registerDevelopment(UNIT_ID, farSlot, FOUNDRY, alicePub);
  });
  const farDev = await getDev(farDevId);
  if (!await expect("no dev created at slot 99", String(farDev?.initialised ?? "false"), "false")) failures++;

  // Bonus: registering at slot 0 should also fail (slots are 1-indexed)
  logStep("DA8b: ATTACK — register at devSlot 0");
  const zeroSlot = UInt64.from(0);
  const zeroDevId = devIdFor(UNIT_ID, zeroSlot);
  await sendAuth("authority registerDevelopment slot 0 (should fail)", async () => {
    await devs.registerDevelopment(UNIT_ID, zeroSlot, FOUNDRY, alicePub);
  });
  const zeroDev = await getDev(zeroDevId);
  if (!await expect("no dev created at slot 0", String(zeroDev?.initialised ?? "false"), "false")) failures++;

  // ── SUMMARY ────────────────────────────────────────────────────
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
