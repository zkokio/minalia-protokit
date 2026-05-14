"use client";
import { Faucet } from "@/components/faucet";
import { DevelopmentYieldCard } from "@/components/development-yield-card";
import { useFaucet } from "@/lib/stores/balances";
import { useDevelopmentYield } from "@/lib/stores/developmentYield";
import { useWalletStore } from "@/lib/stores/wallet";

export default function Home() {
  const wallet = useWalletStore();
  const drip = useFaucet();
  const dev = useDevelopmentYield();

  return (
    <div className="mx-auto -mt-32 h-full pt-16">
      <div className="flex h-full w-full items-start justify-center gap-6 pt-16">
        <div className="flex basis-4/12 flex-col items-center justify-center 2xl:basis-3/12">
          <Faucet
            wallet={wallet.wallet}
            walletInstalled={wallet.walletInstalled}
            onConnectWallet={wallet.connectWallet}
            onDrip={drip}
            loading={false}
          />
        </div>
        <div className="flex basis-5/12 flex-col items-center justify-center 2xl:basis-4/12">
          <DevelopmentYieldCard
            wallet={wallet.wallet}
            walletInstalled={wallet.walletInstalled}
            onConnectWallet={wallet.connectWallet}
            onInitialiseDev={dev.initialiseDev}
            onUpdateDecisions={dev.updateDecisions}
            onTick={dev.tick}
            loading={false}
          />
        </div>
      </div>
    </div>
  );
}
