import { PrivateKey, UInt64 } from "o1js";
import { Balance, TokenId } from "@proto-kit/library";
import { buildNodeClient } from "../core/environments/node.config";
import {
  TreasuryKey,
  TREASURY_CLASS,
  ZARKIS_TOKEN_ID,
} from "../runtime/modules/treasury";

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
  const signerKey = PrivateKey.random();
  const signerPub = signerKey.toPublicKey();
  console.log("Test signer:", signerPub.toBase58());
  console.log(`Settle wait per tx: ${SETTLE_MS / 1000}s`);

  const client = buildNodeClient(signerKey, GRAPHQL_URL);
  await client.start();

  const treasury = client.runtime.resolve("MinaliaTreasury");

  async function getBalance(key: TreasuryKey): Promise<string> {
    const b = await client.query.runtime.MinaliaTreasury.balances.get(key);
    return b?.toString() ?? "0";
  }

  async function getSupply(tokenId: TokenId) {
    const s = await client.query.runtime.MinaliaTreasury.supplies.get(tokenId);
    return s ? {
      minted: s.minted.toString(),
      burned: s.burned.toString(),
      cap: s.cap.toString(),
    } : null;
  }

  async function send(label: string, build: () => Promise<unknown>) {
    console.log(`→ ${label}`);
    const tx = await client.transaction(signerPub, build as any);
    await tx.sign();
    await tx.send();
    await wait(SETTLE_MS);
  }

  async function expect(label: string, actual: string, expected: string) {
    const pass = actual === expected;
    const symbol = pass ? "✓" : "✗";
    console.log(`  ${symbol} ${label}: got=${actual}, expected=${expected}`);
    return pass;
  }

  let failures = 0;
  const playerKey = TreasuryKey.fromPlayer(signerPub, ZARKIS_TOKEN_ID);
  const duelPotKey = TreasuryKey.fromDuelPot(ZARKIS_TOKEN_ID);

  logStep("TEST 1: setSupplyCap(ZARKIS, 1000)");
  await send("setSupplyCap", async () => {
    await treasury.setSupplyCap(ZARKIS_TOKEN_ID, Balance.from(1000));
  });
  const supply1 = await getSupply(ZARKIS_TOKEN_ID);
  console.log("  supply state:", supply1);
  if (!await expect("supply.cap", supply1?.cap ?? "null", "1000")) failures++;

  logStep("TEST 2: mint 100 ZARKIS to player");
  await send("mint", async () => {
    await treasury.mint(playerKey, Balance.from(100));
  });
  const bal2 = await getBalance(playerKey);
  const sup2 = await getSupply(ZARKIS_TOKEN_ID);
  console.log("  player balance:", bal2);
  console.log("  supply:", sup2);
  if (!await expect("player balance", bal2, "100")) failures++;
  if (!await expect("supply.minted", sup2?.minted ?? "null", "100")) failures++;

  logStep("TEST 3: debit 30 ZARKIS from player");
  await send("debit", async () => {
    await treasury.debit(playerKey, Balance.from(30));
  });
  const bal3 = await getBalance(playerKey);
  console.log("  player balance:", bal3);
  if (!await expect("player balance", bal3, "70")) failures++;

  logStep("TEST 4: credit 50 ZARKIS to player");
  await send("credit", async () => {
    await treasury.credit(playerKey, Balance.from(50));
  });
  const bal4 = await getBalance(playerKey);
  console.log("  player balance:", bal4);
  if (!await expect("player balance", bal4, "120")) failures++;

  logStep("TEST 5: transfer 20 ZARKIS player → DUEL-POT");
  await send("transfer", async () => {
    await treasury.transfer(playerKey, duelPotKey, Balance.from(20));
  });
  const bal5p = await getBalance(playerKey);
  const bal5d = await getBalance(duelPotKey);
  console.log("  player balance:", bal5p);
  console.log("  DUEL-POT balance:", bal5d);
  if (!await expect("player balance", bal5p, "100")) failures++;
  if (!await expect("DUEL-POT balance", bal5d, "20")) failures++;

  logStep("TEST 6: burn 10 ZARKIS from player");
  await send("burn", async () => {
    await treasury.burn(playerKey, Balance.from(10));
  });
  const bal6 = await getBalance(playerKey);
  const sup6 = await getSupply(ZARKIS_TOKEN_ID);
  console.log("  player balance:", bal6);
  console.log("  supply:", sup6);
  if (!await expect("player balance", bal6, "90")) failures++;
  if (!await expect("supply.burned", sup6?.burned ?? "null", "10")) failures++;

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
