import { create } from "zustand";
import { Client, useClientStore } from "./client";
import { immer } from "zustand/middleware/immer";
import { PendingTransaction, UnsignedTransaction } from "@proto-kit/sequencer";
import { Balance, BalancesKey, TokenId } from "@proto-kit/library";
import { Field, PublicKey, UInt64 } from "o1js";
import { useCallback, useEffect } from "react";
import { useChainStore } from "./chain";
import { useWalletStore } from "./wallet";

export type MinaliaTokenSymbol = "ZARKIS" | "PLASM" | "WIRE" | "LICHEN" | "SPORE";

export const MINALIA_TOKENS: { symbol: MinaliaTokenSymbol; tokenId: TokenId }[] = [
  { symbol: "ZARKIS", tokenId: TokenId.from(1) },
  { symbol: "PLASM",  tokenId: TokenId.from(2) },
  { symbol: "WIRE",   tokenId: TokenId.from(3) },
  { symbol: "LICHEN", tokenId: TokenId.from(4) },
  { symbol: "SPORE",  tokenId: TokenId.from(5) },
];

export function tokenIdFor(symbol: MinaliaTokenSymbol): TokenId {
  const entry = MINALIA_TOKENS.find((t) => t.symbol === symbol);
  if (!entry) throw new Error(`Unknown Minalia token: ${symbol}`);
  return entry.tokenId;
}

export interface DevelopmentYieldState {
  loading: boolean;
  tokenBalances: { [address: string]: { [sym in MinaliaTokenSymbol]?: string } };
  loadAllBalances: (client: Client, address: string) => Promise<void>;
  initialiseDev: (
    client: Client,
    address: string,
    devId: number,
    yieldTokenSymbol: MinaliaTokenSymbol,
    baseYield: number,
    cycleLength: number,
  ) => Promise<PendingTransaction>;
  updateDecisions: (
    client: Client,
    address: string,
    devId: number,
    decisionA: number,
    decisionB: number,
    decisionC: number,
  ) => Promise<PendingTransaction>;
  tick: (
    client: Client,
    address: string,
    devId: number,
  ) => Promise<PendingTransaction>;
}

function isPendingTransaction(
  transaction: PendingTransaction | UnsignedTransaction | undefined,
): asserts transaction is PendingTransaction {
  if (!(transaction instanceof PendingTransaction))
    throw new Error("Transaction is not a PendingTransaction");
}

export const useDevelopmentYieldStore = create<DevelopmentYieldState, [["zustand/immer", never]]>(
  immer((set) => ({
    loading: Boolean(false),
    tokenBalances: {},
    async loadAllBalances(client: Client, address: string) {
      const pk = PublicKey.fromBase58(address);
      const results: { [sym in MinaliaTokenSymbol]?: string } = {};
      for (const { symbol, tokenId } of MINALIA_TOKENS) {
        const key = BalancesKey.from(tokenId, pk);
        const balance = await client.query.runtime.Balances.balances.get(key);
        results[symbol] = balance?.toString() ?? "0";
      }
      set((state) => {
        state.tokenBalances[address] = results;
      });
    },
    async initialiseDev(client, address, devId, yieldTokenSymbol, baseYield, cycleLength) {
      const dev = client.runtime.resolve("DevelopmentYield");
      const sender = PublicKey.fromBase58(address);
      const tx = await client.transaction(sender, async () => {
        await dev.initialiseDev(
          Field(devId),
          sender,
          sender,
          tokenIdFor(yieldTokenSymbol),
          // @ts-ignore
          Balance.from(baseYield * 1e9),
          UInt64.from(cycleLength),
        );
      });
      await tx.sign();
      await tx.send();
      isPendingTransaction(tx.transaction);
      return tx.transaction;
    },
    async updateDecisions(client, address, devId, decisionA, decisionB, decisionC) {
      const dev = client.runtime.resolve("DevelopmentYield");
      const sender = PublicKey.fromBase58(address);
      const tx = await client.transaction(sender, async () => {
        await dev.updateDecisions(
          Field(devId),
          UInt64.from(decisionA),
          UInt64.from(decisionB),
          UInt64.from(decisionC),
        );
      });
      await tx.sign();
      await tx.send();
      isPendingTransaction(tx.transaction);
      return tx.transaction;
    },
    async tick(client, address, devId) {
      const dev = client.runtime.resolve("DevelopmentYield");
      const sender = PublicKey.fromBase58(address);
      const tx = await client.transaction(sender, async () => {
        await dev.tick(Field(devId));
      });
      await tx.sign();
      await tx.send();
      isPendingTransaction(tx.transaction);
      return tx.transaction;
    },
  })),
);

export const useObserveAllBalances = () => {
  const client = useClientStore();
  const chain = useChainStore();
  const wallet = useWalletStore();
  const dev = useDevelopmentYieldStore();

  useEffect(() => {
    if (!client.client || !wallet.wallet) return;
    dev.loadAllBalances(client.client, wallet.wallet);
  }, [client.client, chain.block?.height, wallet.wallet]);
};

export const useDevelopmentYield = () => {
  const client = useClientStore();
  const dev = useDevelopmentYieldStore();
  const wallet = useWalletStore();

  const initialiseDev = useCallback(
    async (devId: number, yieldTokenSymbol: MinaliaTokenSymbol, baseYield: number, cycleLength: number) => {
      if (!client.client || !wallet.wallet) return;
      const pending = await dev.initialiseDev(client.client, wallet.wallet, devId, yieldTokenSymbol, baseYield, cycleLength);
      wallet.addPendingTransaction(pending);
    },
    [client.client, wallet.wallet],
  );

  const updateDecisions = useCallback(
    async (devId: number, a: number, b: number, c: number) => {
      if (!client.client || !wallet.wallet) return;
      const pending = await dev.updateDecisions(client.client, wallet.wallet, devId, a, b, c);
      wallet.addPendingTransaction(pending);
    },
    [client.client, wallet.wallet],
  );

  const tick = useCallback(
    async (devId: number) => {
      if (!client.client || !wallet.wallet) return;
      const pending = await dev.tick(client.client, wallet.wallet, devId);
      wallet.addPendingTransaction(pending);
    },
    [client.client, wallet.wallet],
  );

  return { initialiseDev, updateDecisions, tick };
};
