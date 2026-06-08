# MINALIA on Protokit

MINALIA is an on-chain territory game on Mina, where the game's economy (ownership, tax, sales, yields, employment) runs on a Protokit appchain. The actual game logic — content, lore, social state, UI — stays in Supabase. This repo is the on-chain economy plus the off-chain signing bridge that connects them.

This is a **snapshot** taken from a working dev branch for the Protokit team to review. It is not a runnable Protokit project on its own; it's the MINALIA-specific runtime modules, tests, and bridge scripts we've built on top of the Protokit starter.

---

## What's here

### Runtime modules (`src/runtime/modules/`)

| Module | What it does |
|---|---|
| `treasury.ts` | Multi-class vaults (player, minister, king, duel-pot). Mint, burn, transfer, forceTransfer. Per-token supply caps. King-gated via genesis config. |
| `ledger.ts` | Append-only audit log keyed by global index. Every money movement and ownership event writes here. `record` is a plain helper, not chain-addressable. |
| `unitRegistry.ts` | On-chain ownership graph. Units keyed by `Poseidon(territoryId, slot)`. Territories store minister hashes. Deployer-gated mutations. Exports `performUnitTransfer` and `assertMinisterOf` as shared helpers. |
| `tax.ts` | Per-unit weekly tax with all-or-nothing debt accrual. Composes `UnitRegistry` (read owner + minister) and `Treasury` (move the money via `forceTransfer`). Minister-gated per-territory. |
| `sales.ts` | Two-step marketplace (`list`, `cancelListing`, `buy`). 2% fee deducted from seller proceeds, paid to the territory minister. Stale-listing protection. |
| `developmentRegistry.ts` | Per-unit development tracking. Each dev keyed by `Poseidon(unitId, devSlot)` with type, upgrade level, architect, and manager fields. **Minister-gated per-territory** via `assertMinisterOf`. 1-to-15 slot cap enforced on-chain. |
| `jobRegistry.ts` | On-chain employment records. `startEmployment` hires an employee for a development under a per-employment wage and cadence (`cycleBlocks`); `payCycle` moves wage from territory vault to employee, with anti-replay enforcement; `terminate` ends employment and clears the dev's manager. Minister-gated per-territory. |

### Off-chain signer service (`scripts/`)

| File | What it does |
|---|---|
| `signer-service.ts` | Long-running Node HTTP service that holds the 20 minister keys (plus deployer/king) and signs runtime methods on behalf of authenticated callers. Localhost-only (`127.0.0.1:8090`). Authenticated via `X-Signer-Auth` shared secret with constant-time compare. Lazy `buildNodeClient` per territory. First piece of off-chain → on-chain bridge infrastructure. |
| `smoke-signer.ts` | End-to-end smoke test: bootstraps fresh chain state (assign minister, register unit, mint into vault, register development), then calls `/sign/job-registry/start-employment` and verifies the on-chain employment record. |
| `smoke-signer-2.ts` | Builds on `smoke-signer.ts`: calls `/sign/job-registry/pay-cycle` (verifies cycle advance + exact vault decrement + `lastPayoutAt` advance) and `/sign/job-registry/terminate` (verifies status transition). |

### Tests (`src/test/`)

End-to-end tests run against a local Protokit `inmemory` chain. Each test boots a node client, sends signed transactions, waits for settlement, and verifies state.

| Test | Assertions | Covers |
|---|---|---|
| `treasury-test.ts` | 21 | Authority-gated mint/burn/setSupplyCap, sender-owns-from on transfer, forceTransfer for system moves, automatic ledger entries on every movement |
| `unit-registry-test.ts` | 15 | Genesis-config authority, assignMinister, registerUnit, transferUnit, adversarial non-authority register |
| `tax-test.ts` | 11 | Happy path payment, debt accrual when player can't pay, multi-cycle accrual, full clearance when player gets funds |
| `sales-test.ts` | 31 | 6 happy paths + 9 adversarial scenarios + a static design audit on ownership entry points |
| `development-registry-test.ts` | 21 | 5 happy paths + 8 adversarial scenarios (intruder mutations, missing unit, occupied slot, out-of-range slot, empty-PublicKey architect) |
| `job-registry-test.ts` | 14 + 8 attacks | Lifecycle (`startEmployment`, `payCycle`, `terminate`, rehire, cannot-pay-after-terminate) plus 8 attack scenarios (intruder start/pay/terminate, employee-self-pay, cross-territory minister, double-hire, fake-dev, wrong-unit hire) |
| `job-registry-cadence-test.ts` | 4 | Atomic revert on insufficient treasury (cycleN does not advance on failure), anti-replay guard in both directions (too-soon revert + success-after-window) |

**Total: 99 + 22 + 4 = 125 assertions, all passing on a live chain.**

The ledger is covered indirectly by every test (treasury writes MINT/BURN/TRANSFER, sales writes SALE/SALE_FEE, tax writes TAX, unit/dev/job writes lifecycle events).

### Migration plan (`docs/MIGRATION.md`)

The roadmap: principle, what lives on-chain vs off-chain, modules planned in order, open design questions.

---

## Running these tests against a Protokit chain

The tests in `src/test/` are node scripts that submit signed transactions to a live Protokit chain via GraphQL. They expect the chain to be running on `localhost:8080`.

**Important #1: start the chain directly with `node` — not via `pnpm dev`.** Running the chain through `pnpm dev` (which invokes `turbo run dev`) silently drops every transaction in our environment. The chain produces blocks normally but every block reports `0 txs`. No errors are logged. State reads return null. We hit this for several hours before realising the wrapper was the cause; details and a reproduction in [proto-kit/framework#519](https://github.com/proto-kit/framework/issues/519).

**Important #2: 22 keys are required, baked in at genesis.** MINALIA's authority model now splits into three roles, with one private key per role:

| Role | Env var | What it signs |
|---|---|---|
| Deployer (1) | `MINALIA_DEPLOYER_PRIVATE_KEY` | UnitRegistry mutations (`assignMinister`, `registerUnit`, `transferUnit`), Tax config |
| King (1) | `MINALIA_KING_PRIVATE_KEY` | Treasury mint/burn/setSupplyCap/forceTransfer |
| Ministers (20) | `MINALIA_MINISTER_LUM_01_PRIVATE_KEY` … `LUM_20_PRIVATE_KEY` | Per-territory: Tax collection, Development mutations, Job mutations |

The corresponding public keys are committed in `runtime/index.ts` (constants `DEPLOYER_PUB`, `KING_PUB`, `MINISTER_PUBS[]`). The chain process must have all 22 private keys in env at startup; tests load whichever subset they need.

Generate the full set with:

```bash
cd packages/chain && node ./scripts/generate-minalia-keys.mjs
```

That writes public keys to stdout (for pasting into `runtime/index.ts`) and a private-key env file you keep gitignored. The actual file used in this repo lives outside the snapshot.

To start the chain reliably:

```bash
cd packages/chain

# Required Protokit env
export PROTOKIT_ENV_FOLDER=inmemory
export PROTOKIT_GRAPHQL_PORT=8080
export PROTOKIT_TRANSACTION_FEE_RECIPIENT_PUBLIC_KEY=B62qqZ3Un6RFLTwQpwttcYqnX2AHBuLg7KmYqGWRz4hMMruq4mYDyGh

# Load all 22 MINALIA keys (deployer + king + 20 ministers) at once
set -a && source ~/minalia-keys.env && set +a

nohup node \
  --loader ts-node/esm \
  --experimental-vm-modules \
  --experimental-wasm-modules \
  --es-module-specifier-resolution=node \
  ./src/start.ts \
  start ./core/environments/inmemory/chain.config.ts \
  --logLevel debug \
  > /tmp/protokit.log 2>&1 &
```

Wait until you see `Produced block #N (0 txs)` in `/tmp/protokit.log`, then run the tests (same shell, so they inherit the env vars):

```bash
pnpm test:treasury     # 21 assertions
pnpm test:units        # 15 assertions
pnpm test:tax          # 11 assertions
pnpm test:sales        # 31 assertions
pnpm test:devs         # 21 assertions
pnpm test:jobs         # 14 + 8 attacks
pnpm test:jobs-cadence # 4 assertions
```

**Important #3: the chain must be restarted between test runs.** Each test allocates throwaway keys for its actors and registers them as ministers/owners; running multiple tests against the same chain causes state collisions. Restart, run one test, repeat.

Each test boots its own node client(s), submits txs, and waits 10–20 seconds per tx for settlement before checking state. The full suite takes about 40–50 minutes end-to-end.

---

## Running the signer service

The signer is a long-running Node service. It needs the chain running on port 8080 and the same env vars sourced as the chain.

```bash
cd packages/chain

# Same env as the chain
set -a && source ~/minalia-keys.env && set +a

# Pick a 32+ char shared secret and add it to the env file or export it
export MINALIA_SIGNER_SECRET=$(openssl rand -hex 32)

nohup node \
  --loader ts-node/esm \
  --experimental-vm-modules \
  --experimental-wasm-modules \
  --es-module-specifier-resolution=node \
  ./scripts/signer-service.ts \
  > /tmp/signer.log 2>&1 &
```

Health check (no auth required):

```bash
curl -s http://127.0.0.1:8090/health
# {"ok":true,"ministers":20}
```

Authenticated call:

```bash
curl -s -X POST http://127.0.0.1:8090/sign/job-registry/start-employment \
  -H "X-Signer-Auth: $MINALIA_SIGNER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"territory":"LUM-01","unitId":"...","devId":"...","employee":"B62q...","wage":"100","cycleBlocks":"201600"}'
```

The smoke tests under `scripts/smoke-signer*.ts` exercise all three endpoints end-to-end against a live chain.

---

## How this fits into a Protokit project

This repo contains only the MINALIA-specific files. In the actual codebase they live inside a Protokit starter at `packages/chain/src/runtime/modules/` alongside the starter's `Balances`, `Withdrawals`, and `DevelopmentYield` modules.

The included `src/runtime/index.ts` is copied verbatim from the real repo — so it references those starter modules in its imports. That's not an oversight; it's an honest snapshot of how MINALIA's modules slot into a Protokit project. To actually run this code, drop these files into a stock Protokit starter (`protokit-starter-kit`) and the imports resolve.

The `src/test/*.ts` files and `scripts/signer-service.ts` use Protokit's `buildNodeClient` from `core/environments/node.config.ts`. That file isn't in this snapshot because it's part of the starter scaffold.

---

## Architectural notes

### Three-role authority

![Authority map](docs/architecture/authority-map.svg)

MINALIA's authority model is split into three roles with **no on-chain rotation path**. The keys are baked in at genesis (public keys constant in `runtime/index.ts`, private keys gitignored). Each role has its own narrow domain:

- **Deployer (1 key):** chain operator. Bootstraps the chain at genesis — assigns ministers to territories, registers units, sets tax config. Kept alive for rare governance ops (e.g. changing tax rate).
- **King (1 key):** Treasury admin — mints/burns/setSupplyCap/forceTransfer. Collects currency-exchange commission into the king vault. Unrelated to ministers in the security hierarchy.
- **Ministers (20):** one per Luminaea territory (LUM-01 to LUM-20). Each minister key signs their own territory's tax collection, development mutations, and job mutations. Bound permanently to their territory.

**Minister-gating is enforced at runtime via UnitRegistry.** Protokit configs are scalar-only (no StateMap seeding), so per-territory minister authority can't be set in genesis config. Instead, the territory→minister mapping lives in `UnitRegistry.territories` (set by the deployer at bootstrap), and the gated modules call `UnitRegistry.assertMinisterOf(unitId)` at the start of every minister-gated runtime method. Tax, DevelopmentRegistry, and JobRegistry all use this pattern.

Treasury and UnitRegistry/Tax use **genesis-config authority** for their global-scope admin operations: the public key is read from `KING_PUB` / `DEPLOYER_PUB` constants in `runtime/index.ts` and threaded into module configs at chain genesis. There is no `setAuthority` runtime method on these modules and therefore no front-running race where an attacker could claim the authority position before the legitimate operator.

### Composition pattern

![Composition pattern](docs/architecture/composition.svg)

Tax was the first composed module — it uses `tsyringe` `@inject` to call both `MinaliaTreasury` and `MinaliaUnitRegistry` from within its own `@runtimeMethod`s.

The real challenge came with Sales, a *player-driven* module that needs to mutate state owned by another module. When a player signs `Sales.buy(...)`, the `this.transaction.sender` inside any inter-module call is still that player — not "Sales the module." So a naive design that exposes `transferUnit` on UnitRegistry to other modules creates a hole: any user can craft a signed tx to that method directly and steal a unit.

**The Protokit team's recommended pattern** (May 2026, via question): when module A needs to mutate state owned by B and only A should drive it, do *not* add a second `@runtimeMethod` on B for A to call. Instead, **extract the shared mutation logic into a plain (non-`@runtimeMethod`) helper function** that both modules' `@runtimeMethod`s call. Each `@runtimeMethod` does its own access control; the helper is just code, not externally callable.

Applied in three places:

- `unitRegistry.ts` exports `performUnitTransfer(...)` — a plain async function. Both `UnitRegistry.transferUnit` and `MinaliaSales.buy` call it.
- `unitRegistry.ts` also exports `assertMinisterOf(unitId)` — a plain async helper. Called by Tax, DevelopmentRegistry, and JobRegistry runtime methods to gate per-territory minister authority.
- `ledger.ts`'s `record` method was demoted from `@runtimeMethod` to plain. Modules call it via `@inject` exactly as before, but it has no chain-addressable path so it cannot be invoked by a hostile signed tx.

The adversarial test scenarios across `sales-test.ts`, `development-registry-test.ts`, and `job-registry-test.ts` verify the security boundary at module level.

### Off-chain signer service

The signer is the bridge between Supabase (game state, content, social) and the appchain (economy). It exists because the 22 role keys cannot live on the player's device, in Supabase, or in any process that handles untrusted input. They live on the chain box, and only on the chain box. Anything that needs to invoke a minister-gated runtime method talks to the signer over an authenticated localhost HTTP call.

**Security model:**

- Keys are loaded into the signer process at startup from `~/minalia-keys.env`. They never appear in any HTTP response, log line, or error message.
- The service binds `127.0.0.1` only — no public exposure. Any external caller (e.g. a Supabase edge function) must reach the signer via a separate trust-establishing layer (Cloudflare tunnel, Tailscale, etc).
- Auth is a shared secret in an `X-Signer-Auth` header, compared in constant time. Wrong secret → 401, identical-length compare → no timing leak.
- All request validation runs after auth. Unknown territory → 400 with the territory name only; no key information leaks.

**Endpoints (v1, JobRegistry only):**

- `GET /health` — no auth; returns `{ ok: true, ministers: 20 }`
- `POST /sign/job-registry/start-employment` — body: `{territory, unitId, devId, employee, wage, cycleBlocks}`
- `POST /sign/job-registry/pay-cycle` — body: `{territory, devId}`
- `POST /sign/job-registry/terminate` — body: `{territory, devId}`

The service does not block on settlement — it returns immediately after `tx.send()`. Callers query state separately if they need to confirm.

Future endpoints will follow the same pattern: one POST per minister-gated runtime method, grouped by module. Tax collection, development mutations, and any future minister-driven modules will land here as they go online.

### Audit ledger as unified event log

`MinaliaLedger` records both money movements (credit/debit > 0) and ownership events (credit/debit = 0). The `kind` field disambiguates. Off-chain code scans the ledger and filters by `principalClass + principalHash` or `kind`.

Kind ranges by domain:
- 1–24: money movement kinds (MINT, BURN, TAX, YIELD, SALE, etc.)
- 25: generic TRANSFER
- 100–102: unit lifecycle (REGISTERED, TRANSFERRED, MINISTER_ASSIGNED)
- 200–203: development lifecycle (REGISTERED, UPGRADED, ARCHITECT_TRANSFERRED, MANAGER_ASSIGNED)
- 400–402: employment lifecycle (STARTED, PAID, TERMINATED)

### Cross-module reads

Modules can read each other's state via `@inject` and StateMap access. For example, `MinaliaDevelopmentRegistry.registerDevelopment` asserts that the target unit exists in UnitRegistry by reading `this.unitRegistry.units.get(unitId)`. Same pattern used by Tax, Sales, and JobRegistry.

### Block height

Real block height read inside any `@runtimeMethod` via `this.network.block.height`. Used by Tax for cycle scheduling, by JobRegistry for the anti-replay cadence guard on `payCycle`, and by every ledger entry for audit chronology.

### Fee math

Sales applies a 2% fee via basis-points: `fee = price * 200 / 10000`. Integer division truncates toward zero; for small odd prices this rounds slightly in favour of the seller. Negligible at typical denominations.

### Treasury transfer vs forceTransfer

`transfer` is for **player-driven** moves: the sender must own the `from` vault, and `from` must be a player vault.

`forceTransfer` is for **system-driven** moves: only the authority can call it, and the `from` vault can be any class. Used in Tax for collecting from a player's vault into the minister vault, in JobRegistry for moving wages from the minister vault to the employee, and reserved for future yield/leaderboard payouts.

---

## Versions

- `o1js` `2.14.0-dev.e1080`
- `@proto-kit/*` `0.2.0`
- `tsyringe` `^4.10.0`
- Node 18.18.0

---

## Modules done / planned

| Done | Module |
|---|---|
| ✅ | MinaliaTreasury |
| ✅ | MinaliaLedger |
| ✅ | MinaliaUnitRegistry |
| ✅ | MinaliaTax |
| ✅ | MinaliaSales |
| ✅ | MinaliaDevelopmentRegistry |
| ✅ | MinaliaJobRegistry |

| Done (off-chain) | Component |
|---|---|
| ✅ | Signer service (JobRegistry endpoints) |

| Planned | Component |
|---|---|
| | Signer service: Tax + DevelopmentRegistry endpoints |
| | Yields v2 — replaces toy DevelopmentYield, reads from UnitRegistry + DevelopmentRegistry |
| | Build — players paying to construct new developments |
| | Leaderboard Payouts |
| | Duels |
| | Token Exchanges |

See `docs/MIGRATION.md` for the full roadmap.

---

## Contact

Game: [play.minaliens.xyz](https://play.minaliens.xyz)
Mainnet ARKIS token: `B62qohwzFkuzr39maSbXU3Vf6SUqsk7wWdAgyarM8euqCsgij5tbcUV`
