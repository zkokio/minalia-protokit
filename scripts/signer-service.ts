// signer-service.ts — MINALIA on-chain signing service.
// Localhost-only HTTP service. Signs minister-gated runtime methods using
// keys from ~/protokit/minalia-keys.env. Never binds beyond 127.0.0.1.
// Authenticated via X-Signer-Auth shared secret.
//
// Required env vars (source minalia-keys.env first):
//   MINALIA_MINISTER_LUM_01_PRIVATE_KEY ... LUM_20
//   MINALIA_SIGNER_SECRET   (>= 32 chars)
// Optional:
//   MINALIA_SIGNER_PORT     (default 8090)
//   PROTOKIT_GRAPHQL_URL    (default http://localhost:8080/graphql)

import http from "node:http";
import { PrivateKey, PublicKey, Field, UInt64 } from "o1js";
import { Balance } from "@proto-kit/library";
import { buildNodeClient } from "../src/core/environments/node.config";

const PORT = Number(process.env.MINALIA_SIGNER_PORT ?? 8090);
const HOST = "127.0.0.1";
const GRAPHQL_URL = process.env.PROTOKIT_GRAPHQL_URL ?? "http://localhost:8080/graphql";
const SHARED_SECRET = process.env.MINALIA_SIGNER_SECRET;

if (!SHARED_SECRET || SHARED_SECRET.length < 32) {
  console.error("MINALIA_SIGNER_SECRET env var is required (>= 32 chars).");
  process.exit(1);
}

class ClientError extends Error {}

// territory -> PrivateKey, loaded at startup, never logged.
type Territory = string;
const ministerKeys = new Map<Territory, PrivateKey>();
for (let i = 1; i <= 20; i++) {
  const code = `LUM-${String(i).padStart(2, "0")}`;
  const envName = `MINALIA_MINISTER_LUM_${String(i).padStart(2, "0")}_PRIVATE_KEY`;
  const raw = process.env[envName];
  if (!raw) {
    console.error(`Missing ${envName} — cannot start signer service.`);
    process.exit(1);
  }
  ministerKeys.set(code, PrivateKey.fromBase58(raw));
}
console.log(`[signer] loaded ${ministerKeys.size} minister keys`);

// Lazy node-client per minister.
type Client = Awaited<ReturnType<typeof buildNodeClient>>;
const clientCache = new Map<Territory, Promise<Client>>();
async function clientFor(territory: Territory): Promise<Client> {
  const cached = clientCache.get(territory);
  if (cached) return cached;
  const key = ministerKeys.get(territory);
  if (!key) throw new ClientError(`unknown territory: ${territory}`);
  const promise = (async () => {
    const c = buildNodeClient(key, GRAPHQL_URL);
    await c.start();
    console.log(`[signer] client started for ${territory}`);
    return c;
  })();
  clientCache.set(territory, promise);
  return promise;
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new ClientError("invalid json")); }
    });
    req.on("error", reject);
  });
}

function authOk(req: http.IncomingMessage): boolean {
  const provided = req.headers["x-signer-auth"];
  if (typeof provided !== "string") return false;
  if (provided.length !== SHARED_SECRET!.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ SHARED_SECRET!.charCodeAt(i);
  }
  return diff === 0;
}

function reqStr(body: any, field: string): string {
  const v = body?.[field];
  if (typeof v !== "string" || v.length === 0) {
    throw new ClientError(`missing or invalid: ${field}`);
  }
  return v;
}

async function handleStartEmployment(body: any) {
  const territory   = reqStr(body, "territory");
  const unitId      = reqStr(body, "unitId");
  const devId       = reqStr(body, "devId");
  const employee    = reqStr(body, "employee");
  const wage        = reqStr(body, "wage");
  const cycleBlocks = reqStr(body, "cycleBlocks");

  const client = await clientFor(territory);
  const ministerPub = ministerKeys.get(territory)!.toPublicKey();
  const jobs = client.runtime.resolve("MinaliaJobRegistry");

  const tx = await client.transaction(ministerPub, async () => {
    await jobs.startEmployment(
      Field(unitId),
      Field(devId),
      PublicKey.fromBase58(employee),
      Balance.from(wage),
      UInt64.from(cycleBlocks),
    );
  });
  await tx.sign();
  await tx.send();
  console.log(`[signer] start-employment ${territory} dev=${devId}`);
  return { ok: true };
}

async function handlePayCycle(body: any) {
  const territory = reqStr(body, "territory");
  const devId     = reqStr(body, "devId");
  const client = await clientFor(territory);
  const ministerPub = ministerKeys.get(territory)!.toPublicKey();
  const jobs = client.runtime.resolve("MinaliaJobRegistry");
  const tx = await client.transaction(ministerPub, async () => {
    await jobs.payCycle(Field(devId));
  });
  await tx.sign();
  await tx.send();
  console.log(`[signer] pay-cycle ${territory} dev=${devId}`);
  return { ok: true };
}

async function handleTerminate(body: any) {
  const territory = reqStr(body, "territory");
  const devId     = reqStr(body, "devId");
  const client = await clientFor(territory);
  const ministerPub = ministerKeys.get(territory)!.toPublicKey();
  const jobs = client.runtime.resolve("MinaliaJobRegistry");
  const tx = await client.transaction(ministerPub, async () => {
    await jobs.terminate(Field(devId));
  });
  await tx.sign();
  await tx.send();
  console.log(`[signer] terminate ${territory} dev=${devId}`);
  return { ok: true };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/health" && req.method === "GET") {
      return send(res, 200, { ok: true, ministers: ministerKeys.size });
    }
    if (!authOk(req)) return send(res, 401, { ok: false, error: "auth" });
    if (req.method !== "POST") return send(res, 405, { ok: false, error: "method" });
    const body = await readJson(req);
    if (req.url === "/sign/job-registry/start-employment") {
      return send(res, 200, await handleStartEmployment(body));
    }
    if (req.url === "/sign/job-registry/pay-cycle") {
      return send(res, 200, await handlePayCycle(body));
    }
    if (req.url === "/sign/job-registry/terminate") {
      return send(res, 200, await handleTerminate(body));
    }
    return send(res, 404, { ok: false, error: "not found" });
  } catch (e: any) {
    if (e instanceof ClientError) {
      console.warn(`[signer] 400 ${req.url}: ${e.message}`);
      return send(res, 400, { ok: false, error: e.message });
    }
    console.error(`[signer] 500 ${req.url}:`, e?.stack ?? e);
    return send(res, 500, { ok: false, error: "internal — see logs" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[signer] listening on http://${HOST}:${PORT}`);
});
