import { create } from "zustand";
import { Client, useClientStore } from "./client";
import { immer } from "zustand/middleware/immer";
import { PendingTransaction, UnsignedTransaction } from "@proto-kit/sequencer";
import { Balance, TokenId } from "@proto-kit/library";
import { Field, PublicKey, UInt64 } from "o1js";
import { useCallback } from "react";
import { useWalletStore } from "./wallet";
import { tokenId } from "./balances";

export interface DevelopmentYieldState {
  loading: boolean;
  initialiseDev: (
    client: Client,
    address: string,
    devId: number,
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
  immer(() => ({
    loading: Boolean(false),
    async initialiseDev(
      client: Client,
      address: string,
      devId: number,
      baseYield: number,
      cycleLength: number,
    ) {
      const dev = client.runtime.resolve("DevelopmentYield");
      const sender = PublicKey.fromBase58(address);

      const tx = await client.transaction(sender, async () => {
        await dev.initialiseDev(
          Field(devId),
          sender,
          sender,
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
      devId: number,
      decisionA: number,
      decisionB: number,
      decisionC: number,
    ) {
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
    async tick(client: Client, address: string, devId: number) {
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

export const useDevelopmentYield = () => {
  const client = useClientStore();
  const dev = useDevelopmentYieldStore();
  const wallet = useWalletStore();

  const initialiseDev = useCallback(
    async (devId: number, baseYield: number, cycleLength: number) => {
      if (!client.client || !wallet.wallet) return;
      const pending = await dev.initialiseDev(
        client.client,
        wallet.wallet,
        devId,
        baseYield,
        cycleLength,
      );
      wallet.addPendingTransaction(pending);
    },
    [client.client, wallet.wallet],
  );

  const updateDecisions = useCallback(
    async (devId: number, a: number, b: number, c: number) => {
      if (!client.client || !wallet.wallet) return;
      const pending = await dev.updateDecisions(
        client.client,
        wallet.wallet,
        devId,
        a,
        b,
        c,
      );
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
