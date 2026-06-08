import { PrivateKey, UInt64, Field, Bool, Poseidon } from "o1js";
import { Balance } from "@proto-kit/library";
import { buildNodeClient } from "../core/environments/node.config";
import {
  TreasuryKey,
  ZARKIS_TOKEN_ID,
} from "../runtime/modules/treasury";
import { unitIdFor } from "../runtime/modules/unitRegistry";

const GRAPHQL_URL = process.env.PROTOKIT_GRAPHQL_URL ?? "http://localhost:8080/graphql";
const SETTLE_MS = 20000;

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
  const aliceKey = PrivateKey.random();
  const alicePub = aliceKey.toPublicKey();
  const bobKey = PrivateKey.random();
  const bobPub = bobKey.toPublicKey();
  const charlieKey = PrivateKey.random();
  const charliePub = charlieKey.toPublicKey();
  const intruderKey = PrivateKey.random();
  const intruderPub = intruderKey.toPublicKey();

  // Throwaway minister keypair for the test territory bootstrap.
  const ministerKeyPair = PrivateKey.random();
  const ministerPub = ministerKeyPair.toPublicKey();

  console.log("King:    ", kingPub.toBase58());
  console.log("Deployer:", deployerPub.toBase58());
  console.log("Alice:   ", alicePub.toBase58());
  console.log("Bob:     ", bobPub.toBase58());
  console.log("Charlie: ", charliePub.toBase58());
  console.log("Intruder:", intruderPub.toBase58());
  console.log("Minister:", ministerPub.toBase58());
  console.log("Settle wait per tx:", SETTLE_MS / 1000, "s");

  const kingClient = buildNodeClient(kingKey, GRAPHQL_URL);
  await kingClient.start();
  const deployerClient = buildNodeClient(deployerKey, GRAPHQL_URL);
  await deployerClient.start();
  const aliceClient = buildNodeClient(aliceKey, GRAPHQL_URL);
  await aliceClient.start();
  const bobClient = buildNodeClient(bobKey, GRAPHQL_URL);
  await bobClient.start();
  const charlieClient = buildNodeClient(charlieKey, GRAPHQL_URL);
  await charlieClient.start();
  const intruderClient = buildNodeClient(intruderKey, GRAPHQL_URL);
  await intruderClient.start();

  async function send(
    label: string,
    client: any,
    signerPub: any,
    build: () => Promise<unknown>,
  ) {
    console.log(label);
    const tx = await client.transaction(signerPub, build as any);
    await tx.sign();
    await tx.send();
    await wait(SETTLE_MS);
  }

  async function getUnitOwner(unitId: Field): Promise<string> {
    const u = await kingClient.query.runtime.MinaliaUnitRegistry.units.get(unitId);
    return u?.owner.toBase58() ?? "null";
  }

  async function getBalance(key: TreasuryKey): Promise<string> {
    const b = await kingClient.query.runtime.MinaliaTreasury.balances.get(key);
    return b?.toString() ?? "0";
  }

  async function getListing(unitId: Field) {
    const l = await kingClient.query.runtime.MinaliaSales.listings.get(unitId);
    if (!l) return null;
    return {
      seller: l.seller.toBase58(),
      price: l.price.toString(),
      active: l.active.toBoolean(),
    };
  }

  async function expect(label: string, actual: string, expected: string) {
    const pass = actual === expected;
    const symbol = pass ? "PASS" : "FAIL";
    console.log("  ", symbol, label, "got=", actual, "expected=", expected);
    return pass;
  }

  let failures = 0;

  const TERRITORY_ID = Field(800001);
  const MINISTER_HASH = Field(800099);

  const deployerRegistry = deployerClient.runtime.resolve("MinaliaUnitRegistry");
  const kingTreasury = kingClient.runtime.resolve("MinaliaTreasury");

  logStep("BOOTSTRAP: supply cap (king) + territory + units + funding (deployer + king)");

  await send("Treasury.setSupplyCap(ZARKIS, 1000000)", kingClient, kingPub, async () => {
    await kingTreasury.setSupplyCap(ZARKIS_TOKEN_ID, Balance.from(1_000_000));
  });
  await send("UnitRegistry.assignMinister", deployerClient, deployerPub, async () => {
    await deployerRegistry.assignMinister(TERRITORY_ID, MINISTER_HASH, ministerPub);
  });

  for (let s = 1; s <= 15; s++) {
    const slot = UInt64.from(s);
    const isMinHeld = s === 13 ? Bool(true) : Bool(false);
    await send("UnitRegistry.registerUnit slot " + s, deployerClient, deployerPub, async () => {
      await deployerRegistry.registerUnit(TERRITORY_ID, slot, alicePub, isMinHeld);
    });
  }

  const aliceVault = TreasuryKey.fromPlayer(alicePub, ZARKIS_TOKEN_ID);
  const bobVault = TreasuryKey.fromPlayer(bobPub, ZARKIS_TOKEN_ID);
  const charlieVault = TreasuryKey.fromPlayer(charliePub, ZARKIS_TOKEN_ID);
  const ministerVault = TreasuryKey.fromMinister(MINISTER_HASH, ZARKIS_TOKEN_ID);

  await send("mint 200000 to Bob", kingClient, kingPub, async () => {
    await kingTreasury.mint(bobVault, Balance.from(200000));
  });
  await send("mint 2000 to Charlie", kingClient, kingPub, async () => {
    await kingTreasury.mint(charlieVault, Balance.from(2000));
  });

  logStep("H1: Alice lists slot 1 for 500, Bob buys");
  const u1 = unitIdFor(TERRITORY_ID, UInt64.from(1));
  const aliceSales = aliceClient.runtime.resolve("MinaliaSales");
  const bobSales = bobClient.runtime.resolve("MinaliaSales");
  const charlieSales = charlieClient.runtime.resolve("MinaliaSales");

  const aliceBalBefore = Number(await getBalance(aliceVault));
  const bobBalBefore = Number(await getBalance(bobVault));
  const ministerBalBefore = Number(await getBalance(ministerVault));

  await send("Alice lists slot 1 for 500", aliceClient, alicePub, async () => {
    await aliceSales.list(u1, Balance.from(500));
  });
  await send("Bob buys slot 1", bobClient, bobPub, async () => {
    await bobSales.buy(u1);
  });

  const aliceBalH1 = Number(await getBalance(aliceVault));
  const bobBalH1 = Number(await getBalance(bobVault));
  const ministerBalH1 = Number(await getBalance(ministerVault));

  if (!await expect("Bob owns slot 1", await getUnitOwner(u1), bobPub.toBase58())) failures++;
  if (!await expect("Alice gained 490", String(aliceBalH1 - aliceBalBefore), "490")) failures++;
  if (!await expect("Bob paid 500", String(bobBalBefore - bobBalH1), "500")) failures++;
  if (!await expect("Minister gained 10", String(ministerBalH1 - ministerBalBefore), "10")) failures++;
  if (!await expect("Slot 1 listing inactive", String((await getListing(u1))?.active ?? "null"), "false")) failures++;

  logStep("H2: Alice lists slot 2, cancels");
  const u2 = unitIdFor(TERRITORY_ID, UInt64.from(2));
  await send("Alice lists slot 2 for 500", aliceClient, alicePub, async () => {
    await aliceSales.list(u2, Balance.from(500));
  });
  if (!await expect("Slot 2 listing active after list", String((await getListing(u2))?.active ?? "null"), "true")) failures++;

  await send("Alice cancels slot 2", aliceClient, alicePub, async () => {
    await aliceSales.cancelListing(u2);
  });
  if (!await expect("Slot 2 listing inactive after cancel", String((await getListing(u2))?.active ?? "null"), "false")) failures++;
  if (!await expect("Alice still owns slot 2", await getUnitOwner(u2), alicePub.toBase58())) failures++;

  logStep("H3: Re-list slot 2 at 700, Bob buys");
  const aliceBalBeforeH3 = Number(await getBalance(aliceVault));
  const ministerBalBeforeH3 = Number(await getBalance(ministerVault));

  await send("Alice re-lists slot 2 for 700", aliceClient, alicePub, async () => {
    await aliceSales.list(u2, Balance.from(700));
  });
  await send("Bob buys slot 2 at new price", bobClient, bobPub, async () => {
    await bobSales.buy(u2);
  });

  if (!await expect("Bob owns slot 2", await getUnitOwner(u2), bobPub.toBase58())) failures++;
  if (!await expect("Alice gained 686", String(Number(await getBalance(aliceVault)) - aliceBalBeforeH3), "686")) failures++;
  if (!await expect("Minister gained 14", String(Number(await getBalance(ministerVault)) - ministerBalBeforeH3), "14")) failures++;

  logStep("H4: Large price - slot 3 for 100000");
  const u3 = unitIdFor(TERRITORY_ID, UInt64.from(3));
  const aliceBalBeforeH4 = Number(await getBalance(aliceVault));
  const ministerBalBeforeH4 = Number(await getBalance(ministerVault));

  await send("Alice lists slot 3 for 100000", aliceClient, alicePub, async () => {
    await aliceSales.list(u3, Balance.from(100000));
  });
  await send("Bob buys slot 3", bobClient, bobPub, async () => {
    await bobSales.buy(u3);
  });

  if (!await expect("Alice gained 98000", String(Number(await getBalance(aliceVault)) - aliceBalBeforeH4), "98000")) failures++;
  if (!await expect("Minister gained 2000", String(Number(await getBalance(ministerVault)) - ministerBalBeforeH4), "2000")) failures++;

  logStep("H5: Odd price slot 4 for 99");
  const u4 = unitIdFor(TERRITORY_ID, UInt64.from(4));
  const aliceBalBeforeH5 = Number(await getBalance(aliceVault));
  const ministerBalBeforeH5 = Number(await getBalance(ministerVault));

  await send("Alice lists slot 4 for 99", aliceClient, alicePub, async () => {
    await aliceSales.list(u4, Balance.from(99));
  });
  await send("Bob buys slot 4", bobClient, bobPub, async () => {
    await bobSales.buy(u4);
  });

  if (!await expect("Alice gained 98 (rounding to seller)", String(Number(await getBalance(aliceVault)) - aliceBalBeforeH5), "98")) failures++;
  if (!await expect("Minister gained 1", String(Number(await getBalance(ministerVault)) - ministerBalBeforeH5), "1")) failures++;

  logStep("H6: Simultaneous listings - list slot 5 and 6, sell only slot 5");
  const u5 = unitIdFor(TERRITORY_ID, UInt64.from(5));
  const u6 = unitIdFor(TERRITORY_ID, UInt64.from(6));

  await send("Alice lists slot 5 for 500", aliceClient, alicePub, async () => {
    await aliceSales.list(u5, Balance.from(500));
  });
  await send("Alice lists slot 6 for 300", aliceClient, alicePub, async () => {
    await aliceSales.list(u6, Balance.from(300));
  });
  await send("Bob buys slot 5", bobClient, bobPub, async () => {
    await bobSales.buy(u5);
  });

  if (!await expect("Bob owns slot 5", await getUnitOwner(u5), bobPub.toBase58())) failures++;
  if (!await expect("Alice still owns slot 6", await getUnitOwner(u6), alicePub.toBase58())) failures++;
  if (!await expect("Slot 6 listing still active", String((await getListing(u6))?.active ?? "null"), "true")) failures++;

  logStep("A1: ATTACK - Intruder lists Alice slot 7");
  const u7 = unitIdFor(TERRITORY_ID, UInt64.from(7));
  const intruderSales = intruderClient.runtime.resolve("MinaliaSales");

  await send("Intruder lists slot 7 for 1 should fail", intruderClient, intruderPub, async () => {
    await intruderSales.list(u7, Balance.from(1));
  });
  const u7Listing = await getListing(u7);
  if (!await expect("No active listing for slot 7", String(u7Listing?.active ?? "false"), "false")) failures++;
  if (!await expect("Alice still owns slot 7", await getUnitOwner(u7), alicePub.toBase58())) failures++;

  logStep("A2: ATTACK - Intruder cancels Alice listing slot 8");
  const u8 = unitIdFor(TERRITORY_ID, UInt64.from(8));
  await send("Alice lists slot 8 for 500 legit", aliceClient, alicePub, async () => {
    await aliceSales.list(u8, Balance.from(500));
  });
  await send("Intruder cancels slot 8 should fail", intruderClient, intruderPub, async () => {
    await intruderSales.cancelListing(u8);
  });
  if (!await expect("Slot 8 listing still active after intruder", String((await getListing(u8))?.active ?? "null"), "true")) failures++;

  logStep("A4: ATTACK - Intruder calls UnitRegistry.transferUnit");
  const u9 = unitIdFor(TERRITORY_ID, UInt64.from(9));
  const intruderRegistry = intruderClient.runtime.resolve("MinaliaUnitRegistry");
  await send("Intruder transferUnit slot 9 should fail", intruderClient, intruderPub, async () => {
    await intruderRegistry.transferUnit(u9, intruderPub);
  });
  if (!await expect("Alice still owns slot 9", await getUnitOwner(u9), alicePub.toBase58())) failures++;

  logStep("A5: ATTACK - Bob with too little ARKIS tries to buy");
  const u10 = unitIdFor(TERRITORY_ID, UInt64.from(10));
  await send("Alice lists slot 10 for 5000000", aliceClient, alicePub, async () => {
    await aliceSales.list(u10, Balance.from(5_000_000));
  });
  const aliceBalBeforeA5 = await getBalance(aliceVault);
  const bobBalBeforeA5 = await getBalance(bobVault);
  await send("Bob tries to buy slot 10 should fail", bobClient, bobPub, async () => {
    await bobSales.buy(u10);
  });
  if (!await expect("Bob balance unchanged", await getBalance(bobVault), bobBalBeforeA5)) failures++;
  if (!await expect("Alice balance unchanged", await getBalance(aliceVault), aliceBalBeforeA5)) failures++;
  if (!await expect("Alice still owns slot 10", await getUnitOwner(u10), alicePub.toBase58())) failures++;
  if (!await expect("Slot 10 listing still active", String((await getListing(u10))?.active ?? "null"), "true")) failures++;

  logStep("A6: ATTACK - Double-spend same listing");
  const u11 = unitIdFor(TERRITORY_ID, UInt64.from(11));
  await send("Alice lists slot 11 for 500", aliceClient, alicePub, async () => {
    await aliceSales.list(u11, Balance.from(500));
  });
  await send("Bob buys slot 11", bobClient, bobPub, async () => {
    await bobSales.buy(u11);
  });
  const charlieBalBeforeA6 = await getBalance(charlieVault);
  await send("Charlie tries to buy slot 11 should fail", charlieClient, charliePub, async () => {
    await charlieSales.buy(u11);
  });
  if (!await expect("Bob still owns slot 11", await getUnitOwner(u11), bobPub.toBase58())) failures++;
  if (!await expect("Charlie balance unchanged", await getBalance(charlieVault), charlieBalBeforeA6)) failures++;

  logStep("A7: ATTACK - Stale listing after admin transfer");
  const u12 = unitIdFor(TERRITORY_ID, UInt64.from(12));
  await send("Alice lists slot 12 for 500", aliceClient, alicePub, async () => {
    await aliceSales.list(u12, Balance.from(500));
  });
  await send("Deployer transfers slot 12 to Charlie", deployerClient, deployerPub, async () => {
    await deployerRegistry.transferUnit(u12, charliePub);
  });
  if (!await expect("Charlie now owns slot 12", await getUnitOwner(u12), charliePub.toBase58())) failures++;

  const bobBalBeforeA7 = await getBalance(bobVault);
  await send("Bob tries to buy slot 12 stale should fail", bobClient, bobPub, async () => {
    await bobSales.buy(u12);
  });
  if (!await expect("Bob balance unchanged", await getBalance(bobVault), bobBalBeforeA7)) failures++;
  if (!await expect("Charlie still owns slot 12", await getUnitOwner(u12), charliePub.toBase58())) failures++;

  logStep("A8: ATTACK - List minister-held unit");
  const u13 = unitIdFor(TERRITORY_ID, UInt64.from(13));
  await send("Alice tries list minister-held slot 13 should fail", aliceClient, alicePub, async () => {
    await aliceSales.list(u13, Balance.from(500));
  });
  if (!await expect("Slot 13 has no active listing", String((await getListing(u13))?.active ?? "false"), "false")) failures++;

  logStep("A9: ATTACK - List at price 0");
  const u14 = unitIdFor(TERRITORY_ID, UInt64.from(14));
  await send("Alice tries list slot 14 for 0 should fail", aliceClient, alicePub, async () => {
    await aliceSales.list(u14, Balance.from(0));
  });
  if (!await expect("Slot 14 has no active listing", String((await getListing(u14))?.active ?? "false"), "false")) failures++;

  logStep("A10: ATTACK - Buy unlisted unit");
  const u15 = unitIdFor(TERRITORY_ID, UInt64.from(15));
  const bobBalBeforeA10 = await getBalance(bobVault);
  await send("Bob tries buy unlisted slot 15 should fail", bobClient, bobPub, async () => {
    await bobSales.buy(u15);
  });
  if (!await expect("Bob balance unchanged", await getBalance(bobVault), bobBalBeforeA10)) failures++;
  if (!await expect("Alice still owns slot 15", await getUnitOwner(u15), alicePub.toBase58())) failures++;

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
