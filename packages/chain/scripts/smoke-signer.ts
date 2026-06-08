// smoke-signer.ts — End-to-end smoke test for the signer service.
// Bootstraps fresh chain state using direct keys (deployer, king, LUM-01),
// then asks the signer service to sign startEmployment as LUM-01,
// then verifies the on-chain employment record exists with the right fields.

import { PrivateKey, UInt64, Field, Bool } from "o1js";
import { Balance } from "@proto-kit/library";
import { buildNodeClient } from "../src/core/environments/node.config";
import { unitIdFor } from "../src/runtime/modules/unitRegistry";
import { devIdFor } from "../src/runtime/modules/developmentRegistry";
import { employmentIdFor } from "../src/runtime/modules/jobRegistry";
import { TreasuryKey, ZARKIS_TOKEN_ID } from "../src/runtime/modules/treasury";

const GRAPHQL_URL = "http://localhost:8080/graphql";
const SIGNER_URL = "http://127.0.0.1:8090";
const SETTLE_MS = 10000;

const DEPLOYER = process.env.MINALIA_DEPLOYER_PRIVATE_KEY;
const KING = process.env.MINALIA_KING_PRIVATE_KEY;
const LUM01 = process.env.MINALIA_MINISTER_LUM_01_PRIVATE_KEY;
const SECRET = process.env.MINALIA_SIGNER_SECRET;

if (!DEPLOYER || !KING || !LUM01 || !SECRET) {
  console.error("Missing env vars. Did you source minalia-keys.env?");
  process.exit(1);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const deployerKey = PrivateKey.fromBase58(DEPLOYER!);
  const deployerPub = deployerKey.toPublicKey();
  const kingKey = PrivateKey.fromBase58(KING!);
  const kingPub = kingKey.toPublicKey();
  const lum01Key = PrivateKey.fromBase58(LUM01!);
  const lum01Pub = lum01Key.toPublicKey();
  const architectKey = PrivateKey.random();
  const architectPub = architectKey.toPublicKey();
  const employeeKey = PrivateKey.random();
  const employeePub = employeeKey.toPublicKey();

  console.log("Deployer: ", deployerPub.toBase58());
  console.log("King:     ", kingPub.toBase58());
  console.log("LUM-01:   ", lum01Pub.toBase58());
  console.log("Architect:", architectPub.toBase58());
  console.log("Employee: ", employeePub.toBase58());

  const TERRITORY_ID = Field(1);
  const MINISTER_HASH = Field(1);
  const UNIT_SLOT = UInt64.from(1);
  const UNIT_ID = unitIdFor(TERRITORY_ID, UNIT_SLOT);
  const DEV_SLOT = UInt64.from(1);
  const DEV_ID = devIdFor(UNIT_ID, DEV_SLOT);
  const EMP_ID = employmentIdFor(DEV_ID);
  const FOUNDRY = UInt64.from(1);
  const WAGE = Balance.from(100);
  const CYCLE_BLOCKS = UInt64.from(3);
  const TREASURY_SEED = Balance.from(10_000);

  const ministerVaultKey = TreasuryKey.fromMinister(MINISTER_HASH, ZARKIS_TOKEN_ID);

  console.log("\nTerritory:", TERRITORY_ID.toString());
  console.log("UnitId:   ", UNIT_ID.toString());
  console.log("DevId:    ", DEV_ID.toString());
  console.log("EmpId:    ", EMP_ID.toString());

  const deployer = buildNodeClient(deployerKey, GRAPHQL_URL);
  await deployer.start();
  const king = buildNodeClient(kingKey, GRAPHQL_URL);
  await king.start();
  const minister = buildNodeClient(lum01Key, GRAPHQL_URL);
  await minister.start();

  const registry = deployer.runtime.resolve("MinaliaUnitRegistry");
  const kingTreasury = king.runtime.resolve("MinaliaTreasury");
  const ministerDevs = minister.runtime.resolve("MinaliaDevelopmentRegistry");

  async function send(client: any, sender: any, label: string, build: () => Promise<unknown>) {
    console.log("\n>>", label);
    const t = await client.transaction(sender, build as any);
    await t.sign();
    await t.send();
    await wait(SETTLE_MS);
  }

  console.log("\n=== BOOTSTRAP ===");

  await send(deployer, deployerPub, "assignMinister(LUM-01 territory -> real LUM-01 pub)", async () => {
    await registry.assignMinister(TERRITORY_ID, MINISTER_HASH, lum01Pub);
  });

  await send(deployer, deployerPub, "registerUnit slot 1 owner=architect", async () => {
    await registry.registerUnit(TERRITORY_ID, UNIT_SLOT, architectPub, Bool(false));
  });

  await send(king, kingPub, "Treasury.setSupplyCap", async () => {
    await kingTreasury.setSupplyCap(ZARKIS_TOKEN_ID, Balance.from(1_000_000));
  });

  await send(king, kingPub, "Treasury.mint into LUM-01 vault", async () => {
    await kingTreasury.mint(ministerVaultKey, TREASURY_SEED);
  });

  await send(minister, lum01Pub, "registerDevelopment slot 1 on UNIT (minister-signed)", async () => {
    await ministerDevs.registerDevelopment(UNIT_ID, DEV_SLOT, FOUNDRY, architectPub);
  });

  console.log("\n=== BOOTSTRAP COMPLETE ===");

  console.log("\n=== SIGNER CALL ===");
  console.log(">> POST /sign/job-registry/start-employment");

  const res = await fetch(`${SIGNER_URL}/sign/job-registry/start-employment`, {
    method: "POST",
    headers: {
      "X-Signer-Auth": SECRET!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      territory: "LUM-01",
      unitId: UNIT_ID.toString(),
      devId: DEV_ID.toString(),
      employee: employeePub.toBase58(),
      wage: WAGE.toString(),
      cycleBlocks: CYCLE_BLOCKS.toString(),
    }),
  });
  const resBody = await res.json();
  console.log("Signer response:", res.status, JSON.stringify(resBody));

  if (!resBody.ok) {
    console.error("\nFAIL: signer returned error");
    process.exit(1);
  }

  console.log("\nWaiting for settlement...");
  await wait(SETTLE_MS);

  console.log("\n=== VERIFICATION ===");
  const e = await deployer.query.runtime.MinaliaJobRegistry.employments.get(EMP_ID);

  if (!e) {
    console.error("FAIL: no employment record found on chain");
    process.exit(1);
  }

  const onchainEmployee = e.employee.toBase58();
  const onchainWage = e.weeklyWageArkis.toString();
  const onchainCycleBlocks = e.cycleBlocks?.toString() ?? "(unset)";
  const onchainStatus = e.status.toString();
  const onchainInit = e.initialised.toBoolean();

  console.log("On-chain employment record:");
  console.log("  initialised: ", onchainInit);
  console.log("  employee:    ", onchainEmployee);
  console.log("  wage:        ", onchainWage);
  console.log("  cycleBlocks: ", onchainCycleBlocks);
  console.log("  status:      ", onchainStatus);

  let pass = true;
  if (!onchainInit) { console.error("  FAIL: not initialised"); pass = false; }
  if (onchainEmployee !== employeePub.toBase58()) { console.error("  FAIL: employee mismatch"); pass = false; }
  if (onchainWage !== "100") { console.error("  FAIL: wage mismatch (got " + onchainWage + ")"); pass = false; }

  if (pass) {
    console.log("\n=== SMOKE TEST PASSED ===");
    console.log("Signer service signed startEmployment as the real LUM-01 minister.");
    console.log("Chain accepted the tx and the employment record matches.");
    process.exit(0);
  } else {
    console.error("\n=== SMOKE TEST FAILED ===");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nUncaught error:", err);
  process.exit(1);
});
