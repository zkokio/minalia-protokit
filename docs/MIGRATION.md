# MINALIA on Protokit — Migration Plan

*Living document. Update as decisions land.*

---

## Principle

**Money and ownership are on-chain. Content and UX are off-chain.**

If a thing involves real value moving between parties (ARKIS, other tokens, units, jobs, contracts), it lives on the Protokit appchain. If a thing is content, presentation, or fast UI state (lore, images, messages, tune scores, caches), it lives in Supabase.

The chain is the source of truth for the **economy**. Supabase is the source of truth for the **experience**.

---

## Why Protokit at all?

MINALIA needs an appchain — not just a token — for one concrete reason: the game's economy should be verifiable and trustless. ARKIS being on Mina mainnet is good. But if all ownership, all tax, all sales, all yields live in a Postgres database owned by one developer, the chain currency is decorative. Players have to trust the operator the same way they would for any web2 game.

Putting the economy on Protokit means:

- Ownership is provable, not asserted by a server.
- Tax, yields, and payouts are deterministic and auditable.
- If MINALIA the website disappears, the chain state survives. Players still own their units and ARKIS.
- Anyone can build clients, bots, leaderboards, analytics on the public chain state.
- The ledger module records every money movement with its reason — a complete audit trail by construction.

The line is **medium**: enough on-chain to make "on-chain game" mean something, not so much that every UI interaction is a tx.

---

## What lives where

### On-chain (Protokit)

- **Tokens** — ARKIS (already on Mina mainnet), PLASM, WIRE, LICHEN, SPORE
- **Treasuries** — player vaults, minister vaults, king vaults, duel pot
- **Ledger** — every credit/debit with reason and block height
- **Unit ownership** — who owns which unit, in which territory, under which minister
- **Developments** — per-unit dev tracking: type, upgrade level, architect, manager
- **Jobs / employment** — which player works for which minister or manager
- **Tax** — weekly per-unit charge from owner to minister
- **Yields** — development payouts and splits
- **Sales / transfers** — unit ownership changes, with payment
- **Wages** — minister/manager paying employed players
- **Manager cycles** — cycle progression, decisions, payouts
- **Leaderboard payouts** — weekly ARKIS distribution
- **Duels** — staking, escrow, payouts, refunds
- **Token exchanges** — swaps between in-game tokens
- **Supply caps and inflation** — minted/burned tracking per token

### Off-chain (Supabase and existing stack)

- Lore content, situations, dialogue text
- Minister/Minalien portraits and image assets
- Messages between players
- Onboarding flows
- Tune scores, battery state (gameplay state, not money)
- UI caches and derived views
- Leaderboard display (chain owns the payouts; Supabase ranks them visually)
- Alerts and notifications
- Auctions UI state (final settlement may move on-chain in a later phase)
- Alliance social state (membership tracked on-chain, social activity off-chain)

### Bridge: how the two sides communicate

- Off-chain Supabase reads chain state through a Protokit GraphQL client to render UI.
- On-chain state changes triggered by Supabase use a **tax authority key** (or per-domain authority key) — a dedicated Mina key held by the backend, used to sign system-driven transactions (tax cycles, weekly payouts, scheduled events).
- Player-driven actions (sale, duel stake, transfer) are signed by the player via Auro Wallet, which is already integrated.

---

## What's already done

| Module | Status | Notes |
|---|---|---|
| Balances | done | From Protokit starter |
| Withdrawals | done | From Protokit starter |
| DevelopmentYield (v1) | done | Toy version; will be superseded by Yields v2 |
| MinaliaTreasury | done | Multi-class vaults, supply caps, mint/burn/transfer |
| MinaliaLedger | done | Audit ledger for any principal, any token, any kind |
| Treasury and Ledger wiring | done | Every money movement writes typed receipts |
| MinaliaUnitRegistry | done | Ownership graph (units, territories), authority-gated. Exports `performUnitTransfer` shared helper |
| MinaliaTax | done | Per-unit weekly tax with all-or-nothing debt accrual. First composed module |
| MinaliaSales | done | Two-step marketplace (list/cancel/buy), 2% minister fee, stale-listing protection. First player-driven composed module |
| MinaliaDevelopmentRegistry | done | Per-unit dev tracking (devType, upgradeLevel, architect, manager). Cross-module unit existence check. 1-to-15 slot cap enforced on-chain |

**Total: 110 assertions across 6 test scripts, all passing on a live chain.**

---

## Module composition: the established convention

For modules that compose with each other, follow the **helper-function pattern** (Protokit team's recommended approach, May 2026):

- Shared mutation logic lives in a plain async function (NOT decorated with `@runtimeMethod`).
- Both modules' `@runtimeMethod`s call the helper.
- Each `@runtimeMethod` does its own access control (authority check, ownership check, signature verification, etc).
- The helper has no chain-addressable path, so no user transaction can invoke it directly.

This was learned the hard way: the first Sales design tried to expose a method on UnitRegistry for Sales to call. Because `transaction.sender` inside Protokit is always the original tx signer (never "the calling module"), that approach left a hole where any user could craft a signed tx to the exposed method and bypass Sales' fee/payment logic.

The helper-function pattern dissolves the problem: you can't address a plain function from a chain tx. It's just code.

`unitRegistry.ts`'s `performUnitTransfer` is the reference example — see how `UnitRegistry.transferUnit` and `MinaliaSales.buy` both call it, each doing their own validation first.

---

## Modules planned (rough order)

Each module is one to a few sessions of work. Order matters: later modules read from earlier ones.

1. **JobRegistry** — employment
   - `jobs: StateMap<JobId, JobState>` with employer, employee, role, wage
   - Methods: `offerJob`, `acceptJob`, `terminateJob`
   - Needed by wages and manager cycles

2. **Yields v2** — development payouts
   - Replaces toy DevelopmentYield
   - Reads from UnitRegistry + DevelopmentRegistry to find owner + architect + manager
   - Uses Treasury for payouts; logs in Ledger
   - Manager share + architect share + owner share split, configured per development type

3. **Wages** — minister/manager paying employed players
   - Reads from JobRegistry
   - Called on a schedule by authority key, or triggered by manager cycle

4. **Manager Cycles** — cycle progression and decisions
   - Tracks per-development cycle state
   - Resolves decisions at cycle boundaries
   - Triggers yields and wages

5. **Build** — players paying to construct new developments
   - Buyer pays construction cost via Treasury; minister gets 5% fee
   - Composes with DevelopmentRegistry's registerDevelopment via the helper pattern

6. **Leaderboard Payouts** — weekly ARKIS distribution
   - 2000/1200/700/300/100 ARKIS to top 5
   - Activity ranking still computed off-chain; payout authoritatively on-chain
   - Mon 08:00 UTC, called by authority key

7. **Duels** — staking, escrow, payouts, refunds
   - Players stake into duel pot
   - Resolved by authority key (until automated resolution is possible)
   - Payouts and refunds go through Treasury with appropriate ledger kinds

8. **Token Exchanges** — swaps between ARKIS / PLASM / WIRE / LICHEN / SPORE
   - Rate config per token pair
   - Fees go to a configured destination

---

## Open design questions

These need decisions before or during the relevant module. Not blockers for the doc.

- **Identity:** A playerId on-chain is a Mina PublicKey. How does that relate to MINALIA's existing user UUIDs in Supabase? Likely: Supabase users.id keeps the UUID, users.wallet_address is the canonical Mina key, all on-chain references use the key. Off-chain UUID becomes a display alias.

- **Bootstrapping ownership:** When UnitRegistry launches in production, who owns what? Most likely: a one-time seed script that reads Supabase ownership state and calls `registerUnit` 320 times. Same for DevelopmentRegistry — seed the existing developments. Each call is one tx; ~5s per block on the dev chain.

- **Migration strategy:** Per-module cutover (chain becomes source of truth one module at a time) vs. dual-write (Supabase plus chain in parallel until full migration). Per-module cutover is cleaner but requires care that nothing in Supabase mutates state the chain now owns.

- **Authority key management:** One key for everything, or per-domain keys (tax authority, payout authority, etc)? Single key is simpler; per-domain limits blast radius if a key is compromised.

- **Off-chain scheduler:** Where does the cron live? Today: Supabase pg_cron. After migration: a Node process on the Hetzner box reading chain state, deciding when to act, signing tx with authority key. Needs reliability, observability, and a recovery plan.

- **Failure semantics:** If a chain tx fails (network, gas, assertion), what happens to the Supabase view? Probably: Supabase only updates after observing the tx settled. Until then, the action is "pending".

- **Player UX during settlement:** A 5-15 second wait per action is fine for tax (background) but bad for a unit sale (foreground). Plan: optimistic UI in the client (show pending state), with reconciliation when the tx settles. Supabase notifications can drive the UI flip from "pending" to "confirmed".

- **State explosion:** If the chain stores every unit, every job, every ledger entry, every development, that's a lot of state. Protokit handles it, but performance characteristics over time are unknown. Worth monitoring as we scale.

- **Schema migrations:** Mid-testing, we can drop and rebuild chain state freely. Post-launch, schema changes are migrations. Plan for that before launch, not after.

- **Dev type slug map:** Development types are stored on-chain as UInt64 codes. The slug-to-code mapping (`foundry=1, market=2, ...`) is maintained off-chain in Supabase. Display, lore, art, and balance config all live there. The chain just knows "type 7 is type 7."

---

## What we are explicitly not doing (yet)

- **Full game on-chain.** Messages, lore content, situations, image assets remain in Supabase.
- **Per-action gas for players.** Block fees may exist but won't be passed through to user UX in v1; the appchain economic model may absorb them.
- **Decentralisation beyond Pete.** This is still a single-developer testnet/appchain in testing phase. Trustlessness is the direction, not the current state.
- **Cross-chain bridges.** ARKIS / Zeko / Protokit bridging is a separate, later effort. For now, the appchain has its own canonical balances; bridging follows.

---

## Operating principles for future sessions

When in doubt about whether something belongs on-chain:

> Does it move money, change ownership, or define employment?
>
> Yes → on-chain.
> No → Supabase.

When in doubt about scope:

> Build the module that has the fewest dependencies first.

When composing modules:

> Shared mutation lives in a plain helper function, not a `@runtimeMethod`. Each runtime method does its own access control.

When in doubt about correctness:

> Write the adversarial tests *at design time*, not after. Then test on a live local chain before committing. Every tx should settle, every ledger entry should appear, every assertion should hold.

---

## Glossary

- **Appchain** — application-specific blockchain. MINALIA's Protokit instance.
- **Authority key** — a Mina key the backend holds to sign system-driven transactions.
- **Ledger entry** — an audit row written by the Treasury for every money movement. Tagged with principal, kind, block height.
- **Principal** — the party a ledger entry concerns. Can be a player, minister, king, or duel pot.
- **Treasury class** — the kind of vault: PLAYER, MINISTER, KING_LUM, DUEL_POT.
- **Settle** — the chain confirming a transaction by including it in a block.
- **Helper function** — a plain async function (no `@runtimeMethod` decorator) used to share mutation logic between modules without exposing a chain-callable entry point.
- **Architect** — the player who built a development. Gets a yield share.
- **Manager** — the player currently managing a development. Gets a manager share, separate from the architect.

---

*Last update: six modules done (Treasury, Ledger, UnitRegistry, Tax, Sales, DevelopmentRegistry). 110 test assertions passing. Helper-function composition pattern established and applied. Next planned: JobRegistry.*
