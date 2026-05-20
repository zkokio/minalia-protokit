import { PrivateKey, UInt64, Poseidon } from "o1js";
import { Balance } from "@proto-kit/library";
import { buildNodeClient } from "../core/environments/node.config";
import { LEDGER_KIND, PRINCIPAL_CLASS } from "../runtime/modules/playerLedger";
import { ZARKIS_TOKEN_ID } from "../runtime/modules/treasury";

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

  const ledger = client.runtime.resolve("MinaliaPlayerLedger");

  async function getNextIndex(): Promise<string> {
    const n = await client.query.runtime.MinaliaPlayerLedger.nextIndex.get();
    return n?.toString() ?? "0";
  }

  async function getEntry(index: UInt64) {
    const e = await client.query.runtime.MinaliaPlayerLedger.entries.get(index);
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

  // Read starting state (might be non-zero from previous tests)
  const startIndex = await getNextIndex();
  const startIdxNum = Number(startIndex);
  console.log(`Starting nextIndex: ${startIndex}`);

  const playerHash = Poseidon.hash(signerPub.toFields());

  // ── TEST 1: Record a MINT credit ────────────────────────────────
  logStep("TEST 1: record MINT credit of 100 ZARKIS");
  await send("record(MINT)", async () => {
    await ledger.record(
      PRINCIPAL_CLASS.PLAYER,
      playerHash,
      ZARKIS_TOKEN_ID,
      Balance.from(100),
      Balance.from(0),
      LEDGER_KIND.MINT,
      UInt64.from(1),
    );
  });

  const entry1 = await getEntry(UInt64.from(startIdxNum));
  console.log("  entry:", entry1);
  if (!await expect("entry credit", entry1?.credit ?? "null", "100")) failures++;
  if (!await expect("entry debit", entry1?.debit ?? "null", "0")) failures++;
  if (!await expect("entry kind", entry1?.kind ?? "null", "1")) failures++;
  if (!await expect("entry principalClass", entry1?.principalClass ?? "null", "1")) failures++;
  if (!await expect("entry principalHash", entry1?.principalHash ?? "null", playerHash.toString())) failures++;

  const idx1 = await getNextIndex();
  if (!await expect("nextIndex after 1 tx", idx1, String(startIdxNum + 1))) failures++;

  // ── TEST 2: Record a TAX debit ──────────────────────────────────
  logStep("TEST 2: record TAX debit of 30 ZARKIS");
  await send("record(TAX)", async () => {
    await ledger.record(
      PRINCIPAL_CLASS.PLAYER,
      playerHash,
      ZARKIS_TOKEN_ID,
      Balance.from(0),
      Balance.from(30),
      LEDGER_KIND.TAX,
      UInt64.from(2),
    );
  });

  const entry2 = await getEntry(UInt64.from(startIdxNum + 1));
  console.log("  entry:", entry2);
  if (!await expect("entry credit", entry2?.credit ?? "null", "0")) failures++;
  if (!await expect("entry debit", entry2?.debit ?? "null", "30")) failures++;
  if (!await expect("entry kind", entry2?.kind ?? "null", "3")) failures++;

  const idx2 = await getNextIndex();
  if (!await expect("nextIndex after 2 txs", idx2, String(startIdxNum + 2))) failures++;

  // ── TEST 3: Record a YIELD credit ───────────────────────────────
  logStep("TEST 3: record YIELD credit of 50 ZARKIS");
  await send("record(YIELD)", async () => {
    await ledger.record(
      PRINCIPAL_CLASS.PLAYER,
      playerHash,
      ZARKIS_TOKEN_ID,
      Balance.from(50),
      Balance.from(0),
      LEDGER_KIND.YIELD,
      UInt64.from(3),
    );
  });

  const entry3 = await getEntry(UInt64.from(startIdxNum + 2));
  console.log("  entry:", entry3);
  if (!await expect("entry credit", entry3?.credit ?? "null", "50")) failures++;
  if (!await expect("entry kind", entry3?.kind ?? "null", "4")) failures++;

  const idx3 = await getNextIndex();
  if (!await expect("nextIndex after 3 txs", idx3, String(startIdxNum + 3))) failures++;

  // ── SUMMARY ─────────────────────────────────────────────────────
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
