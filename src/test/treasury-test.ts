import { PrivateKey, UInt64, Poseidon } from "o1js";
import { Balance, TokenId } from "@proto-kit/library";
import { buildNodeClient } from "../core/environments/node.config";
import {
  TreasuryKey,
  TREASURY_CLASS,
  ZARKIS_TOKEN_ID,
} from "../runtime/modules/treasury";
import { LEDGER_KIND } from "../runtime/modules/ledger";

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

  async function getLedgerNextIndex(): Promise<number> {
    const n = await client.query.runtime.MinaliaLedger.nextIndex.get();
    return Number(n?.toString() ?? "0");
  }

  async function getLedgerEntry(index: number) {
    const e = await client.query.runtime.MinaliaLedger.entries.get(UInt64.from(index));
    if (!e) return null;
    return {
      principalClass: e.principalClass.toString(),
      principalHash: e.principalHash.toString(),
      token: e.token.toString(),
      credit: e.credit.toString(),
      debit: e.debit.toString(),
      kind: e.kind.toString(),
      blockHeight: e.blockHeight.toString(),
    };
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

  // Pre-compute principal hashes so we can check ledger entries against them
  const playerPrincipalHash = Poseidon.hash(signerPub.toFields()).toString();
  // DuelPot principalHash is Field(0) per TreasuryKey.fromDuelPot

  const ledgerStart = await getLedgerNextIndex();
  console.log(`Starting ledger nextIndex: ${ledgerStart}`);

  logStep("TEST 1: setSupplyCap(ZARKIS, 1000)");
  await send("setSupplyCap", async () => {
    await treasury.setSupplyCap(ZARKIS_TOKEN_ID, Balance.from(1000));
  });
  const supply1 = await getSupply(ZARKIS_TOKEN_ID);
  console.log("  supply state:", supply1);
  if (!await expect("supply.cap", supply1?.cap ?? "null", "1000")) failures++;

  logStep("TEST 2: mint 100 ZARKIS to player (writes ledger entry)");
  await send("mint", async () => {
    await treasury.mint(playerKey, Balance.from(100));
  });
  const bal2 = await getBalance(playerKey);
  const sup2 = await getSupply(ZARKIS_TOKEN_ID);
  console.log("  player balance:", bal2);
  console.log("  supply:", sup2);
  if (!await expect("player balance", bal2, "100")) failures++;
  if (!await expect("supply.minted", sup2?.minted ?? "null", "100")) failures++;

  // Verify ledger entry for the mint
  const mintEntry = await getLedgerEntry(ledgerStart);
  console.log("  ledger entry:", mintEntry);
  if (!await expect("ledger credit", mintEntry?.credit ?? "null", "100")) failures++;
  if (!await expect("ledger debit", mintEntry?.debit ?? "null", "0")) failures++;
  if (!await expect("ledger kind (MINT=1)", mintEntry?.kind ?? "null", "1")) failures++;
  if (!await expect("ledger principalClass (PLAYER=1)", mintEntry?.principalClass ?? "null", "1")) failures++;
  if (!await expect("ledger principalHash", mintEntry?.principalHash ?? "null", playerPrincipalHash)) failures++;

  logStep("TEST 3: transfer 20 ZARKIS player → DUEL-POT (writes TWO ledger entries)");
  await send("transfer", async () => {
    await treasury.transfer(playerKey, duelPotKey, Balance.from(20), LEDGER_KIND.DUEL_STAKE);
  });
  const bal3p = await getBalance(playerKey);
  const bal3d = await getBalance(duelPotKey);
  console.log("  player balance:", bal3p);
  console.log("  DUEL-POT balance:", bal3d);
  if (!await expect("player balance", bal3p, "80")) failures++;
  if (!await expect("DUEL-POT balance", bal3d, "20")) failures++;

  // Verify two ledger entries
  const transferDebitEntry = await getLedgerEntry(ledgerStart + 1);
  const transferCreditEntry = await getLedgerEntry(ledgerStart + 2);
  console.log("  ledger entry (debit side):", transferDebitEntry);
  console.log("  ledger entry (credit side):", transferCreditEntry);
  if (!await expect("debit-side credit", transferDebitEntry?.credit ?? "null", "0")) failures++;
  if (!await expect("debit-side debit", transferDebitEntry?.debit ?? "null", "20")) failures++;
  if (!await expect("debit-side principalClass (PLAYER=1)", transferDebitEntry?.principalClass ?? "null", "1")) failures++;
  if (!await expect("debit-side kind (DUEL_STAKE=12)", transferDebitEntry?.kind ?? "null", "12")) failures++;
  if (!await expect("credit-side credit", transferCreditEntry?.credit ?? "null", "20")) failures++;
  if (!await expect("credit-side debit", transferCreditEntry?.debit ?? "null", "0")) failures++;
  if (!await expect("credit-side principalClass (DUEL_POT=4)", transferCreditEntry?.principalClass ?? "null", "4")) failures++;
  if (!await expect("credit-side kind (DUEL_STAKE=12)", transferCreditEntry?.kind ?? "null", "12")) failures++;

  logStep("TEST 4: burn 10 ZARKIS from player (writes ledger entry)");
  await send("burn", async () => {
    await treasury.burn(playerKey, Balance.from(10));
  });
  const bal4 = await getBalance(playerKey);
  const sup4 = await getSupply(ZARKIS_TOKEN_ID);
  console.log("  player balance:", bal4);
  console.log("  supply:", sup4);
  if (!await expect("player balance", bal4, "70")) failures++;
  if (!await expect("supply.burned", sup4?.burned ?? "null", "10")) failures++;

  const burnEntry = await getLedgerEntry(ledgerStart + 3);
  console.log("  ledger entry:", burnEntry);
  if (!await expect("ledger credit", burnEntry?.credit ?? "null", "0")) failures++;
  if (!await expect("ledger debit", burnEntry?.debit ?? "null", "10")) failures++;
  if (!await expect("ledger kind (BURN=2)", burnEntry?.kind ?? "null", "2")) failures++;

  // Final check: ledger nextIndex should have advanced by 4 (mint + 2x transfer + burn)
  const ledgerEnd = await getLedgerNextIndex();
  if (!await expect("ledger nextIndex advanced by 4", String(ledgerEnd - ledgerStart), "4")) failures++;

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
