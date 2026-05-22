# MINALIA on Protokit

MINALIA is an on-chain territory game on Mina, where the game's economy (ownership, tax, sales, yields) runs on a Protokit appchain. The actual game logic — content, lore, social state, UI — stays in Supabase. This repo is the on-chain economy.

This is a **snapshot** taken from a working dev branch for the Protokit team to review. It is not a runnable Protokit project on its own; it's the MINALIA-specific runtime modules and tests we've built on top of the Protokit starter.

---

## What's here

### Runtime modules (`src/runtime/modules/`)

| Module | What it does |
|---|---|
| `treasury.ts` | Multi-class vaults (player, minister, king, duel-pot). Mint, burn, transfer. Per-token supply caps. |
| `ledger.ts` | Append-only audit log keyed by global index. Every money movement and ownership event writes here, tagged with principal class, principal hash, token, credit, debit, kind, and block height. |
| `unitRegistry.ts` | On-chain ownership graph. Units keyed by `Poseidon(territoryId, slot)`. Territories store minister hashes. Authority-gated mutations. Exports `performUnitTransfer` as a shared helper. |
| `tax.ts` | Per-unit weekly tax with all-or-nothing debt accrual. Composes `UnitRegistry` (read owner + minister) and `Treasury` (move the money). |
| `sales.ts` | Two-step marketplace (`list`, `cancelListing`, `buy`). 2% fee deducted from seller proceeds, paid to the territory minister. Stale-listing protection. Composes `UnitRegistry` (via the shared helper) and `Treasury`. |

### Tests (`src/test/`)

End-to-end tests run against a local Protokit `inmemory` chain. Each test boots a node client, sends signed transactions, waits for settlement, and verifies state.

| Test | Assertions | Covers |
|---|---|---|
| `treasury-test.ts` | 21 | Supply caps, mint, burn, transfer (with `kind` param), automatic ledger entries on every movement |
| `ledger-test.ts` | 11 | Record with each `LEDGER_KIND`, principal class round-trip, index advancement |
| `unit-registry-test.ts` | 15 | setAuthority bootstrap, assignMinister, registerUnit (player-owned + minister-held), transferUnit, **adversarial: non-authority cannot register a unit** |
| `tax-test.ts` | 11 | Happy path payment, debt accrual when player can't pay, multi-cycle accrual, full clearance when player gets funds |
| `sales-test.ts` | 31 | 6 happy paths + 9 adversarial scenarios (intruder lists, intruder cancels, direct `transferUnit` call, insufficient buyer balance, double-spend, stale listing after authority transfer, minister-held listing, zero price, unlisted buy), plus a static design audit on ownership entry points |

**Total: 89 assertions, all passing on a live chain.**

### Migration plan (`docs/MIGRATION.md`)

The roadmap: principle, what lives on-chain vs off-chain, modules planned in order, open design questions.

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

Applied here:

- `unitRegistry.ts` exports `performUnitTransfer(units, ledger, blockHeight, unitId, newOwner)` — a plain async function, intentionally not decorated.
- `UnitRegistry.transferUnit` does `assertAuthority()`, then calls the helper.
- `MinaliaSales.buy` validates the listing + buyer payment, then calls the same helper, passing `this.registry.units` and `this.registry.ledger`.

Result: only three `@runtimeMethod`s mutate the `units` StateMap's `owner` field — `registerUnit`, `transferUnit`, `buy` — and each enforces its own access controls. The shared helper has no chain-addressable path.

The `sales-test.ts` adversarial scenarios verify the security boundary: an intruder cannot list someone else's unit, cancel someone else's listing, call `transferUnit` directly, buy without funds, double-spend a listing, exploit a stale listing, list a minister-held unit, list at zero price, or buy an unlisted unit. All blocked.

### Audit ledger as unified event log

`MinaliaLedger` records both money movements (credit/debit > 0) and ownership events (credit/debit = 0). The `kind` field disambiguates. Off-chain code scans the ledger and filters by `principalClass + principalHash` or `kind`.

### Authority pattern

Every mutating registry/admin module has a `setAuthority` method that's set-once at bootstrap. After that, only the holder of that key can call mutating methods. Currently one key for testing; in production it'll be split per domain.

### Block height

Real block height read inside any `@runtimeMethod` via `this.network.block.height`. Used by Tax for cycle scheduling and by every ledger entry for audit chronology. API verified by reading `@proto-kit/protocol`'s `NetworkState.ts`.

### Fee math

Sales applies a 2% fee via basis-points: `fee = price * 200 / 10000`. Integer division truncates toward zero; for small odd prices this rounds slightly in favour of the seller (a 99-ARKIS sale yields 98 to seller, 1 to minister, instead of 97.02/1.98). Negligible at typical denominations. The trade-off is acknowledged in the test (`H5`).

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

| Planned | Module |
|---|---|
| | DevelopmentRegistry — per-unit dev/upgrade/architect tracking |
| | JobRegistry — employment relationships |
| | Wages — minister/manager paying employed players |
| | Yields v2 — replaces toy DevelopmentYield, reads from UnitRegistry |
| | Manager Cycles |
| | Leaderboard Payouts |
| | Duels |
| | Token Exchanges |

See `docs/MIGRATION.md` for the full roadmap.

---

## Contact

Game: [play.minaliens.xyz](https://play.minaliens.xyz)
Mainnet ARKIS token: `B62qohwzFkuzr39maSbXU3Vf6SUqsk7wWdAgyarM8euqCsgij5tbcUV`
