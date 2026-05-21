# MINALIA on Protokit — Migration Plan

*Draft. Living document. Update as decisions land.*

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

---

## Modules planned (rough order)

Each module is one to a few sessions of work. Order matters: later modules read from earlier ones.

1. **UnitRegistry** — the ownership graph
   - units StateMap keyed by UnitId with owner, territoryId, ministerId
   - territories StateMap keyed by TerritoryId with minister key
   - Methods: registerUnit, transferUnit, assignMinister
   - Foundation for nearly everything else.

2. **JobRegistry** — employment
   - jobs StateMap keyed by JobId with employer, employee, role, wage
   - Methods: offerJob, acceptJob, terminateJob
   - Needed by wages, manager cycles.

3. **Tax** — per-unit weekly tax
   - Reads from UnitRegistry to find owner and minister
   - Charges owner via treasury.transfer with kind=TAX
   - Accrues debt if owner can't pay (decision from this session)
   - Called by tax authority key on a schedule

4. **Sales** — unit ownership transfer with payment
   - Atomically: player A pays player B via treasury, UnitRegistry updates ownership
   - Optional sale fee to minister
   - Signed by buyer (or both sides via two-step listing/accept)

5. **Yields v2** — development payouts
   - Replaces toy DevelopmentYield
   - Reads from UnitRegistry to find owner; uses Treasury for payouts; logs in Ledger
   - Manager share plus owner share split, configured per development

6. **Wages** — minister/manager paying employed players
   - Reads from JobRegistry
   - Called on a schedule by authority key, or triggered by manager cycle

7. **Manager Cycles** — cycle progression and decisions
   - Tracks per-development cycle state
   - Resolves decisions at cycle boundaries
   - Triggers yields and wages

8. **Leaderboard Payouts** — weekly ARKIS distribution
   - 2000/1200/700/300/100 ARKIS to top 5
   - Activity ranking still computed off-chain; payout authoritatively on-chain
   - Mon 08:00 UTC, called by authority key

9. **Duels** — staking, escrow, payouts, refunds
   - Players stake into duel pot
   - Resolved by authority key (until automated resolution is possible)
   - Payouts and refunds go through Treasury with appropriate ledger kinds

10. **Token Exchanges** — swaps between ARKIS / PLASM / WIRE / LICHEN / SPORE
    - Rate config per token pair
    - Fees go to a configured destination

---

## Open design questions

These need decisions before or during the relevant module. Not blockers for the doc.

- **Identity:** A playerId on-chain is a Mina PublicKey. How does that relate to MINALIA's existing user UUIDs in Supabase? Likely: Supabase users.id keeps the UUID, users.wallet_address is the canonical Mina key, all on-chain references use the key. Off-chain UUID becomes a display alias.

- **Bootstrapping ownership:** When UnitRegistry launches, who owns what? Most likely: a one-time seed runtime method (callable only by deployer) that imports current Supabase ownership state. Then seed is renounced.

- **Migration strategy:** Per-module cutover (chain becomes source of truth one module at a time) vs. dual-write (Supabase plus chain in parallel until full migration). Per-module cutover is cleaner but requires care that nothing in Supabase mutates state the chain now owns.

- **Authority key management:** One key for everything, or per-domain keys (tax authority, payout authority, etc)? Single key is simpler; per-domain limits blast radius if a key is compromised.

- **Off-chain scheduler:** Where does the cron live? Today: Supabase pg_cron. After migration: a Node process on the Hetzner box reading chain state, deciding when to act, signing tx with authority key. Needs reliability, observability, and a recovery plan.

- **Failure semantics:** If a chain tx fails (network, gas, assertion), what happens to the Supabase view? Probably: Supabase only updates after observing the tx settled. Until then, the action is "pending".

- **Player UX during settlement:** A 5-15 second wait per action is fine for tax (background) but bad for a unit sale (foreground). Plan: optimistic UI in the client (show pending state), with reconciliation when the tx settles. Supabase notifications can drive the UI flip from "pending" to "confirmed".

- **State explosion:** If the chain stores every unit, every job, every ledger entry, that's a lot of state. Protokit handles it, but performance characteristics over time are unknown. Worth monitoring as we scale.

- **Schema migrations:** Mid-testing, we can drop and rebuild chain state freely. Post-launch, schema changes are migrations. Plan for that before launch, not after.

---

## What we are explicitly not doing (yet)

- **Full game on-chain.** Messages, lore content, situations, image assets remain in Supabase.
- **Per-action gas for players.** Block fees may exist but won't be passed through to user UX in v1; the appchain economic model may absorb them.
- **Decentralisation beyond Pete.** This is still a single-developer testnet/appchain in testing phase. Trustlessness is the direction, not the current state.
- **Cross-chain bridges.** ARKIS / Zeko / Protokit bridging is a separate, later effort. For now, the appchain has its own canonical balances; bridging follows.

---

## Operating principle for future sessions

When in doubt about whether something belongs on-chain:

> Does it move money, change ownership, or define employment?
>
> Yes → on-chain.
> No → Supabase.

When in doubt about scope:

> Build the module that has the fewest dependencies first.

When in doubt about correctness:

> Test it on a live local chain before committing. Every tx should settle, every ledger entry should appear, every assertion should hold.

---

## Glossary

- **Appchain** — application-specific blockchain. MINALIA's Protokit instance.
- **Authority key** — a Mina key the backend holds to sign system-driven transactions.
- **Ledger entry** — an audit row written by the Treasury for every money movement. Tagged with principal, kind, block height.
- **Principal** — the party a ledger entry concerns. Can be a player, minister, king, or duel pot.
- **Treasury class** — the kind of vault: PLAYER, MINISTER, KING_LUM, DUEL_POT.
- **Settle** — the chain confirming a transaction by including it in a block.

---

*Last meaningful update: this session. Two foundational primitives (Treasury, Ledger) and their wiring are committed. Next planned module: UnitRegistry.*
