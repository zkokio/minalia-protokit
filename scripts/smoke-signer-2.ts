// smoke-signer-2.ts — Tests pay-cycle and terminate endpoints against
// the employment created by smoke-signer.ts. Reuses on-chain state.

import { PrivateKey, UInt64, Field } from "o1js";
import { buildNodeClient } from "../src/core/environments/node.config";
import { unitIdFor } from "../src/runtime/modules/unitRegistry";
import { devIdFor } from "../src/runtime/modules/developmentRegistry";
import { employmentIdFor } from "../src/runtime/modules/jobRegistry";
import { TreasuryKey, ZARKIS_TOKEN_ID } from "../src/runtime/modules/treasury";

const GRAPHQL_URL = "http://localhost:8080/graphql";
const SIGNER_URL = "http://127.0.0.1:8090";
const SETTLE_MS = 10000;

const DEPLOYER = process.env.MINALIA_DEPLOYER_PRIVATE_KEY;
const SECRET = process.env.MINALIA_SIGNER_SECRET;

if (!DEPLOYER || !SECRET) {
  console.error("Missing env vars. Did you source minalia-keys.env?");
  process.exit(1);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callSigner(path: string, body: any) {
  const res = await fetch(`${SIGNER_URL}${path}`, {
    method: "POST",
    headers: {
      "X-Signer-Auth": SECRET!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  const deployerKey = PrivateKey.fromBase58(DEPLOYER!);
  const TERRITORY_ID = Field(1);
  const MINISTER_HASH = Field(1);
  const UNIT_ID = unitIdFor(TERRITORY_ID, UInt64.from(1));
  const DEV_ID = devIdFor(UNIT_ID, UInt64.from(1));
  const EMP_ID = employmentIdFor(DEV_ID);
  const ministerVaultKey = TreasuryKey.fromMinister(MINISTER_HASH, ZARKIS_TOKEN_ID);

  console.log("EmpId:", EMP_ID.toString());

  const deployer = buildNodeClient(deployerKey, GRAPHQL_URL);
  await deployer.start();

  async function getState() {
    const e = await deployer.query.runtime.MinaliaJobRegistry.employments.get(EMP_ID);
    const v = await deployer.query.runtime.MinaliaTreasury.balances.get(ministerVaultKey);
    return {
      exists: !!e,
      currentCycleN: e?.currentCycleN.toString() ?? "0",
      lastPayoutAt: e?.lastPayoutAt.toString() ?? "0",
      status: e?.status.toString() ?? "(none)",
      vault: v?.toString() ?? "0",
    };
  }

  let failures = 0;

  console.log("\n=== STATE BEFORE PAY-CYCLE ===");
  const before = await getState();
  console.log(before);
  if (!before.exists) {
    console.error("FAIL: no employment on chain. Did smoke-signer.ts run first?");
    process.exit(1);
  }
  if (before.status !== "1") {
    console.error("FAIL: employment not ACTIVE (status=" + before.status + ")");
    process.exit(1);
  }

  console.log("\n=== CALL pay-cycle ===");
  const payRes = await callSigner("/sign/job-registry/pay-cycle", {
    territory: "LUM-01",
    devId: DEV_ID.toString(),
  });
  console.log("Signer response:", payRes.status, JSON.stringify(payRes.body));
  if (!payRes.body.ok) {
    console.error("FAIL: pay-cycle signer call returned not-ok");
    process.exit(1);
  }

  await wait(SETTLE_MS);

  console.log("\n=== STATE AFTER PAY-CYCLE ===");
  const afterPay = await getState();
  console.log(afterPay);

  const expectedCycle = (parseInt(before.currentCycleN) + 1).toString();
  if (afterPay.currentCycleN !== expectedCycle) {
    console.error(`FAIL: currentCycleN expected ${expectedCycle}, got ${afterPay.currentCycleN}`);
    failures++;
  } else {
    console.log(`PASS: currentCycleN ${before.currentCycleN} -> ${afterPay.currentCycleN}`);
  }

  const expectedVault = (BigInt(before.vault) - 100n).toString();
  if (afterPay.vault !== expectedVault) {
    console.error(`FAIL: vault expected ${expectedVault}, got ${afterPay.vault}`);
    failures++;
  } else {
    console.log(`PASS: vault ${before.vault} -> ${afterPay.vault} (-100)`);
  }

  if (afterPay.lastPayoutAt === "0") {
    console.error("FAIL: lastPayoutAt still 0");
    failures++;
  } else {
    console.log(`PASS: lastPayoutAt = ${afterPay.lastPayoutAt}`);
  }

  console.log("\n=== CALL terminate ===");
  const termRes = await callSigner("/sign/job-registry/terminate", {
    territory: "LUM-01",
    devId: DEV_ID.toString(),
  });
  console.log("Signer response:", termRes.status, JSON.stringify(termRes.body));
  if (!termRes.body.ok) {
    console.error("FAIL: terminate signer call returned not-ok");
    process.exit(1);
  }

  await wait(SETTLE_MS);

  console.log("\n=== STATE AFTER TERMINATE ===");
  const afterTerm = await getState();
  console.log(afterTerm);

  if (afterTerm.status === "1") {
    console.error("FAIL: status still ACTIVE after terminate");
    failures++;
  } else {
    console.log(`PASS: status ${afterPay.status} -> ${afterTerm.status} (no longer ACTIVE)`);
  }

  if (failures === 0) {
    console.log("\n=== BOTH ENDPOINT TESTS PASSED ===");
    process.exit(0);
  } else {
    console.error(`\n=== ${failures} FAILURE(S) ===`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nUncaught error:", err);
  process.exit(1);
});
