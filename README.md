# MINALIA on Protokit

MINALIA is an on-chain territory game on Mina, where the game's economy (ownership, tax, sales, yields) runs on a Protokit appchain. The actual game logic — content, lore, social state, UI — stays in Supabase. This repo is the on-chain economy.

This is a **snapshot** taken from a working dev branch for the Protokit team to review. It is not a runnable Protokit project on its own; it's the MINALIA-specific runtime modules and tests we've built on top of the Protokit starter.

---

## What's here

### Runtime modules (`src/runtime/modules/`)

| Module | What it does |
|---|---|
| `treasury.ts` | Multi-class vaults (player, minister, king, duel-pot). Mint, burn, transfer, forceTransfer. Per-token supply caps. Authority configured at chain genesis via env var. |
| `ledger.ts` | Append-only audit log keyed by global index. Every money movement and ownership event writes here, tagged with principal class, principal hash, token, credit, debit, kind, and block height. `record` is a plain helper, not chain-addressable. |
| `unitRegistry.ts` | On-chain ownership graph. Units keyed by `Poseidon(territoryId, slot)`. Territories store minister hashes. Authority-gated mutations. Exports `performUnitTransfer` as a shared helper. |
| `tax.ts` | Per-unit weekly tax with all-or-nothing debt accrual. Composes `UnitRegistry` (read owner + minister) and `Treasury` (move the money via `forceTransfer`). |
| `sales.ts` | Two-step marketplace (`list`, `cancelListing`, `buy`). 2% fee deducted from seller proceeds, paid to the territory minister. Stale-listing protection. Composes `UnitRegistry` (via the shared helper) and `Treasury`. |
| `developmentRegistry.ts` | Per-unit development tracking. Each dev keyed by `Poseidon(unitId, devSlot)` with type, upgrade level, architect, and manager fields. Cross-module check that the unit exists. 1-to-15 slot cap enforced on-chain. Empty PublicKey rejected as architect. |

### Tests (`src/test/`)

End-to-end tests run against a local Protokit `inmemory` chain. Each test boots a node client, sends signed transactions, waits for settlement, and verifies state.

| Test | Assertions | Covers |
|---|---|---|
| `treasury-test.ts` | 21 | Authority-gated mint/burn/setSupplyCap, sender-owns-from on transfer, forceTransfer for system moves, automatic ledger entries on every movement |
| `unit-registry-test.ts` | 15 | setAuthority bootstrap, assignMinister, registerUnit (player-owned + minister-held), transferUnit, **adversarial: non-authority cannot register a unit** |
| `tax-test.ts` | 11 | Happy path payment, debt accrual when player can't pay, multi-cycle accrual, full clearance when player gets funds |
| `sales-test.ts` | 31 | 6 happy paths + 9 adversarial scenarios (intruder lists, intruder cancels, direct `transferUnit` call, insufficient buyer balance, double-spend, stale listing after authority transfer, minister-held listing, zero price, unlisted buy), plus a static design audit on ownership entry points |
| `development-registry-test.ts` | 21 | 5 happy paths (register/upgrade/assignManager/transferArchitect/coexisting devs) + 8 adversarial scenarios (intruder mutations, register on missing unit, register on occupied slot, upgrade empty slot, out-of-range slot numbers, empty-PublicKey architect rejected) |

**Total: 99 assertions, all passing on a live chain.**

The ledger is covered indirectly by every test (treasury writes MINT/BURN/TRANSFER, sales writes SALE/SALE_FEE, tax writes TAX, unit/dev writes ownership and lifecycle events). After fix #3, `ledger.record` is no longer chain-callable, so there is no longer a dedicated direct-write test for it.

### Migration plan (`docs/MIGRATION.md`)

The roadmap: principle, what lives on-chain vs off-chain, modules planned in order, open design questions.

---

## Running these tests against a Protokit chain

The tests in `src/test/` are node scripts that submit signed transactions to a live Protokit chain via GraphQL. They expect the chain to be running on `localhost:8080`.

**Important #1: start the chain directly with `node` — not via `pnpm dev`.** Running the chain through `pnpm dev` (which invokes `turbo run dev`) silently drops every transaction in our environment. The chain produces blocks normally but every block reports `0 txs`. No errors are logged. State reads return null. We hit this for several hours before realising the wrapper was the cause; details and a reproduction in [proto-kit/framework#519](https://github.com/proto-kit/framework/issues/519).

**Important #2: `MINALIA_AUTHORITY_PRIVATE_KEY` env var is required.** Treasury's authority key (for `mint`, `burn`, `setSupplyCap`, `forceTransfer`) is baked into the chain at genesis from this env var rather than set via a runtime `setAuthority` call. Both the chain process and every test client must use the same value.

Generate a key for development:

```bash
cd packages/chain && node -e "import('o1js').then(o1js => { const k = o1js.PrivateKey.random(); console.log('private:', k.toBase58()); console.log('public:', k.toPublicKey().toBase58()); });"
```

Save the private key somewhere (a `.env.local` not committed to git is fine). You'll export it any time you start the chain or run tests.

To start the chain reliably:

```bash
cd packages/chain

export PROTOKIT_ENV_FOLDER=inmemory
export PROTOKIT_GRAPHQL_PORT=8080
export PROTOKIT_TRANSACTION_FEE_RECIPIENT_PUBLIC_KEY=B62qqZ3Un6RFLTwQpwttcYqnX2AHBuLg7KmYqGWRz4hMMruq4mYDyGh
export MINALIA_AUTHORITY_PRIVATE_KEY=<your generated private key>

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

Wait until you see `Produced block #N (0 txs)` in `/tmp/protokit.log`, then run the tests (in the same shell, so they inherit `MINALIA_AUTHORITY_PRIVATE_KEY`):

```bash
cd packages/chain
pnpm test:treasury     # 21 assertions
pnpm test:units        # 15 assertions
pnpm test:tax          # 11 assertions
pnpm test:sales        # 31 assertions
pnpm test:devs         # 21 assertions
```

**Important #3: the chain must be restarted between test runs.** `setAuthority` is set-once for UnitRegistry, Tax, and DevelopmentRegistry (Treasury's is in genesis config now, so it has no setAuthority). Running multiple tests against the same chain without restarting causes "Authority already initialised" failures.

Each test boots its own node client(s), submits txs, and waits 10–20 seconds per tx for settlement before checking state. The full suite takes about 30–40 minutes end-to-end.

---

## How this fits into a Protokit project

This repo contains only the MINALIA-specific files. In the actual codebase they live inside a Protokit starter at `packages/chain/src/runtime/modules/` alongside the starter's `Balances`, `Withdrawals`, and `DevelopmentYield` modules.

The included `src/runtime/index.ts` is copied verbatim from the real repo — so it references those starter modules in its imports. That's not an oversight; it's an honest snapshot of how MINALIA's modules slot into a Protokit project. To actually run this code, drop these files into a stock Protokit starter (`protokit-starter-kit`) and the imports resolve.

The included `src/test/*.ts` files use Protokit's `buildNodeClient` from `core/environments/node.config.ts`. That file isn't in this snapshot because it's part of the starter scaffold.

---

## Architectural notes

### Composition pattern (the headline learning)

Tax was the first composed module — it uses `tsyringe` `@inject` to call both `MinaliaTreasury` and `MinaliaUnitRegistry` from within its own `@runtimeMethod`s. This worked fine when all inter-module calls happen via authority-key-gated methods (tax cycles are admin-triggered).

The real challenge came with Sales, a *player-driven* module that needs to mutate state owned by another module. When a player signs `Sales.buy(...)`, the `this.transaction.sender` inside any inter-module call is still that player — not "Sales the module." So a naive design that exposes `transferUnit` on UnitRegistry to other modules creates a hole: any user can craft a signed tx to that method directly and steal a unit. We tried that approach first, caught the gap, and asked.

**The Protokit team's recommended pattern** (May 2026, via question): when module A needs to mutate state owned by B and only A should drive it, do *not* add a second `@runtimeMethod` on B for A to call. Instead, **extract the shared mutation logic into a plain (non-`@runtimeMethod`) helper function** that both modules' `@runtimeMethod`s call. Each `@runtimeMethod` does its own access control; the helper is just code, not externally callable.

Applied in two places:

- `unitRegistry.ts` exports `performUnitTransfer(units, ledger, blockHeight, unitId, newOwner)` — a plain async function, intentionally not decorated. Both `UnitRegistry.transferUnit` and `MinaliaSales.buy` call it.
- `ledger.ts`'s `record` method was demoted from `@runtimeMethod` to plain. Modules call it via `@inject` exactly as before, but it has no chain-addressable path so it cannot be invoked by a hostile signed tx.

The `sales-test.ts` adversarial scenarios verify the security boundary: an intruder cannot list someone else's unit, cancel someone else's listing, call `transferUnit` directly, buy without funds, double-spend a listing, exploit a stale listing, list a minister-held unit, list at zero price, or buy an unlisted unit. All blocked.

### Audit ledger as unified event log

`MinaliaLedger` records both money movements (credit/debit > 0) and ownership events (credit/debit = 0). The `kind` field disambiguates. Off-chain code scans the ledger and filters by `principalClass + principalHash` or `kind`.

Kind ranges by domain:
- 1–24: money movement kinds (MINT, BURN, TAX, YIELD, SALE, etc.)
- 25: generic TRANSFER
- 100–102: unit lifecycle (REGISTERED, TRANSFERRED, MINISTER_ASSIGNED)
- 200–203: development lifecycle (REGISTERED, UPGRADED, ARCHITECT_TRANSFERRED, MANAGER_ASSIGNED)

### Authority pattern

**Treasury** uses **genesis-config authority**: a `TreasuryConfig` interface declares `authority: PublicKey`, and `runtime/index.ts` reads `MINALIA_AUTHORITY_PRIVATE_KEY` from environment at chain startup, derives the public key, and threads it into the module's config. The chain has the authority key baked in from block 0. There is no `setAuthority` runtime method on Treasury and therefore no front-running race window where an attacker could claim the authority position before the legitimate operator.

```typescript
interface TreasuryConfig { authority: PublicKey; }

@runtimeModule()
export class MinaliaTreasury extends RuntimeModule<TreasuryConfig> {
  private async assertAuthority(): Promise<void> {
    const sender = this.transaction.sender.value;
    assert(sender.equals(this.config.authority), "Sender is not the authority");
  }
  // ...
}
```

**UnitRegistry, Tax, and DevelopmentRegistry** still use the older **set-once `setAuthority` pattern**: a `@runtimeMethod setAuthority(key)` that's gated by a `Bool` "initialised" flag. After the first call, subsequent calls fail. Less secure than genesis-config (an attacker could in principle front-run a fresh chain's bootstrap) but functionally fine for testing. Migration of these modules to genesis-config is planned.

### Cross-module reads

Modules can read each other's state via `@inject` and StateMap access. For example, `MinaliaDevelopmentRegistry.registerDevelopment` asserts that the target unit exists in UnitRegistry by reading `this.unitRegistry.units.get(unitId)`. Same pattern used by Tax (looks up owner + minister) and Sales (looks up unit + minister, re-checks ownership at buy time).

### Block height

Real block height read inside any `@runtimeMethod` via `this.network.block.height`. Used by Tax for cycle scheduling and by every ledger entry for audit chronology. API verified by reading `@proto-kit/protocol`'s `NetworkState.ts`.

### Fee math

Sales applies a 2% fee via basis-points: `fee = price * 200 / 10000`. Integer division truncates toward zero; for small odd prices this rounds slightly in favour of the seller (a 99-ARKIS sale yields 98 to seller, 1 to minister, instead of 97.02/1.98). Negligible at typical denominations. The trade-off is acknowledged in the test (`H5`).

### Treasury transfer vs forceTransfer

`transfer` is for **player-driven** moves: the sender must own the `from` vault, and `from` must be a player vault. System vaults (minister, king, duel-pot) cannot be the source. Used in Sales for the buyer-pays-seller leg.

`forceTransfer` is for **system-driven** moves: only the authority can call it, and the `from` vault can be any class. Used in Tax for collecting from a player's vault into the minister vault, and reserved for wages, leaderboard payouts, and admin moves.

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

| Planned | Module |
|---|---|
| | JobRegistry — employment relationships |
| | Yields v2 — replaces toy DevelopmentYield, reads from UnitRegistry + DevelopmentRegistry |
| | Wages — minister/manager paying employed players |
| | Manager Cycles |
| | Build — players paying to construct new developments |
| | Leaderboard Payouts |
| | Duels |
| | Token Exchanges |

See `docs/MIGRATION.md` for the full roadmap.

---

## Contact

Game: [play.minaliens.xyz](https://play.minaliens.xyz)
Mainnet ARKIS token: `B62qohwzFkuzr39maSbXU3Vf6SUqsk7wWdAgyarM8euqCsgij5tbcUV`
