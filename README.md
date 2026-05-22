# MINALIA on Protokit

MINALIA is an on-chain territory game on Mina, where the game's economy (ownership, tax, sales, yields) runs on a Protokit appchain. The actual game logic — content, lore, social state, UI — stays in Supabase. This repo is the on-chain economy.

This is a **snapshot** taken from a working dev branch for the Protokit team to review. It is not the full Protokit starter; it's the MINALIA-specific runtime modules and tests we've built on top of it.

---

## What's here

### Runtime modules (`src/runtime/modules/`)

| Module | What it does |
|---|---|
| `treasury.ts` | Multi-class vaults (player, minister, king, duel-pot). Mint, burn, transfer. Per-token supply caps. |
| `ledger.ts` | Append-only audit log keyed by global index. Every money movement and ownership event writes here, tagged with principal class, principal hash, token, credit, debit, kind, and block height. |
| `unitRegistry.ts` | On-chain ownership graph. Units keyed by `Poseidon(territoryId, slot)`. Territories store minister hashes. Authority-gated mutations. |
| `tax.ts` | Per-unit weekly tax with all-or-nothing debt accrual. Composes `UnitRegistry` (read owner + minister) and `Treasury` (move the money). |

### Tests (`src/test/`)

End-to-end tests run against a local Protokit `inmemory` chain. Each test boots a node client, sends signed transactions, waits for settlement, and verifies state.

| Test | Assertions | Covers |
|---|---|---|
| `treasury-test.ts` | 21 | Supply caps, mint, burn, transfer (with `kind` param), automatic ledger entries on every movement |
| `ledger-test.ts` | 11 | Record with each `LEDGER_KIND`, principal class round-trip, index advancement |
| `unit-registry-test.ts` | 15 | setAuthority bootstrap, assignMinister, registerUnit (player-owned + minister-held), transferUnit, **adversarial: non-authority cannot register a unit** |
| `tax-test.ts` | 11 | Happy path payment, debt accrual when player can't pay, multi-cycle accrual, full clearance when player gets funds |

**Total: 58 assertions, all passing on a live chain.**

### Migration plan (`docs/MIGRATION.md`)

The roadmap: principle, what lives on-chain vs off-chain, modules planned in order, open design questions.

---

## Architectural notes

### Composition pattern

Tax is the first **composed** module — it uses `tsyringe` `@inject` to call both `MinaliaTreasury` and `MinaliaUnitRegistry` from within its own `@runtimeMethod`s. This pattern works fine when all inter-module calls happen via authority-key-gated methods (`Treasury.transfer` is called by Tax which is called by an authority-signed tx).

**An open question we've already hit:** when a *player* signs a tx that needs to mutate state owned by a different module (e.g. Sales updating UnitRegistry ownership), the `transaction.sender` is the player — not the calling module. There's no built-in module identity in Protokit, so a naive "expose a transfer method on UnitRegistry" approach creates a hole where any user can craft a signed tx to that method directly and bypass the calling module's checks.

The Protokit team's recommended pattern (received via question, May 2026): **extract shared mutation logic into plain (non-`@runtimeMethod`) helper functions** that both modules call. Each `@runtimeMethod` does its own access control. The helper is just code, not externally callable.

We're applying this pattern to the next module (Sales).

### Audit ledger as unified event log

`MinaliaLedger` records both money movements (credit/debit > 0) and ownership events (credit/debit = 0). The `kind` field disambiguates. We considered separate event logs per module but chose unified for query simplicity. Off-chain code scans the ledger and filters by `principalClass + principalHash` or `kind`.

### Authority pattern

Every mutating module has a `setAuthority` method that's set-once at bootstrap. After that, only the holder of that key can call mutating methods. The authority can be a different key per module if compartmentalisation matters (currently one key for testing).

### Block height

Real block height read inside any `@runtimeMethod` via `this.network.block.height`. Used by Tax for cycle scheduling and by every ledger entry for audit chronology. We verified the API by reading `@proto-kit/protocol`'s `NetworkState.ts`.

---

## Versions

- `o1js` `2.14.0-dev.e1080`
- `@proto-kit/*` `0.2.0`
- `tsyringe` `^4.10.0`
- Node 18.18.0

---

## What's missing from this snapshot

- The Protokit starter scaffold (sequencer config, web app, balances/withdrawals starter modules) — not included to keep the focus on MINALIA-specific work
- Sales module — currently being redesigned per the Protokit team's helper-function pattern
- Bootstrap script for seeding 320 units from existing Supabase data — planned but not built

---

## Contact

Game: [play.minaliens.xyz](https://play.minaliens.xyz)
Mainnet ARKIS token: `B62qohwzFkuzr39maSbXU3Vf6SUqsk7wWdAgyarM8euqCsgij5tbcUV`
