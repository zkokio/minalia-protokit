import { create } from "zustand";
import { Client, useClientStore } from "./client";
import { immer } from "zustand/middleware/immer";
import { PendingTransaction, UnsignedTransaction } from "@proto-kit/sequencer";
import { Balance, TokenId } from "@proto-kit/library";
import { PublicKey, UInt64 } from "o1js";
import { useCallback } from "react";
import { useWalletStore } from "./wallet";
import { tokenId } from "./balances";

export interface DevelopmentYieldState {
  loading: boolean;
  initialiseDev: (
    client: Client,
    address: string,
    baseYield: number,
    cycleLength: number,
  ) => Promise<PendingTransaction>;
  updateDecisions: (
    client: Client,
    address: string,
    decisionA: number,
    decisionB: number,
    decisionC: number,
  ) => Promise<PendingTransaction>;
  tick: (
    client: Client,
    address: string,
  ) => Promise<PendingTransaction>;
}

function isPendingTransaction(
  transaction: PendingTransaction | UnsignedTransaction | undefined,
): asserts transaction is PendingTransaction {
  if (!(transaction instanceof PendingTransaction))
    throw new Error("Transaction is not a PendingTransaction");
}

export const useDevelopmentYieldStore = create<
  DevelopmentYieldState,
  [["zustand/immer", never]]
>(
  immer(() => ({
    loading: false,
    async initialiseDev(
      client: Client,
      address: string,
      baseYield: number,
      cycleLength: number,
    ) {
      const dev = client.runtime.resolve("DevelopmentYield");
      const sender = PublicKey.fromBase58(address);

      const tx = await client.transaction(sender, async () => {
        await dev.initialiseDev(
          sender,           // manager = self
          sender,           // treasury = self (for testing)
          tokenId,
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
    async updateDecisions(
      client: Client,
      address: string,
      decisionA: number,
      decisionB: number,
      decisionC: number,
    ) {
      const dev = client.runtime.resolve("DevelopmentYield");
      const sender = PublicKey.fromBase58(address);

      const tx = await client.transaction(sender, async () => {
        await dev.updateDecisions(
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
    async tick(client: Client, address: string) {
      const dev = client.runtime.resolve("DevelopmentYield");
      const sender = PublicKey.fromBase58(address);

      const tx = await client.transaction(sender, async () => {
        await dev.tick();
      });

      await tx.sign();
      await tx.send();

      isPendingTransaction(tx.transaction);
      return tx.transaction;
    },
  })),
);

export const useDevelopmentYield = () => {
  const client = useClientStore();
  const dev = useDevelopmentYieldStore();
  const wallet = useWalletStore();

  const initialiseDev = useCallback(
    async (baseYield: number, cycleLength: number) => {
      if (!client.client || !wallet.wallet) return;
      const pending = await dev.initialiseDev(
        client.client,
        wallet.wallet,
        baseYield,
        cycleLength,
      );
      wallet.addPendingTransaction(pending);
    },
    [client.client, wallet.wallet],
  );

  const updateDecisions = useCallback(
    async (a: number, b: number, c: number) => {
      if (!client.client || !wallet.wallet) return;
      const pending = await dev.updateDecisions(
        client.client,
        wallet.wallet,
        a,
        b,
        c,
      );
      wallet.addPendingTransaction(pending);
    },
    [client.client, wallet.wallet],
  );

  const tick = useCallback(async () => {
    if (!client.client || !wallet.wallet) return;
    const pending = await dev.tick(client.client, wallet.wallet);
    wallet.addPendingTransaction(pending);
  }, [client.client, wallet.wallet]);

  return { initialiseDev, updateDecisions, tick };
};
