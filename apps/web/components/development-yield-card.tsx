"use client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel } from "./ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { useForm } from "react-hook-form";
import { Button } from "./ui/button";
import { useState } from "react";
import {
  useDevelopmentYieldStore,
  useObserveAllBalances,
  MINALIA_TOKENS,
  MinaliaTokenSymbol,
} from "@/lib/stores/developmentYield";
import { useWalletStore } from "@/lib/stores/wallet";

export interface DevelopmentYieldCardProps {
  wallet?: string;
  walletInstalled: boolean;
  onConnectWallet: () => void;
  onInitialiseDev: (
    devId: number,
    yieldTokenSymbol: MinaliaTokenSymbol,
    baseYield: number,
    cycleLength: number,
  ) => void;
  onUpdateDecisions: (devId: number, a: number, b: number, c: number) => void;
  onTick: (devId: number) => void;
  loading: boolean;
}

export function DevelopmentYieldCard({
  wallet,
  walletInstalled,
  onConnectWallet,
  onInitialiseDev,
  onUpdateDecisions,
  onTick,
  loading,
}: DevelopmentYieldCardProps) {
  const form = useForm();
  const [devId, setDevId] = useState(1);
  const [yieldToken, setYieldToken] = useState<MinaliaTokenSymbol>("ZARKIS");
  const [baseYield, setBaseYield] = useState(100);
  const [cycleLength, setCycleLength] = useState(1);
  const [decisionA, setDecisionA] = useState(115);
  const [decisionB, setDecisionB] = useState(100);
  const [decisionC, setDecisionC] = useState(100);

  // Live balances for all 5 tokens, refreshed each block
  useObserveAllBalances();
  const tokenBalances = useDevelopmentYieldStore((s) => s.tokenBalances);
  const walletAddr = useWalletStore((s) => s.wallet);
  const balances = walletAddr ? tokenBalances[walletAddr] ?? {} : {};

  const fmtBalance = (raw?: string) =>
    raw ? (Number(raw) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 }) : "0";

  // Preview math
  const multiplier = (decisionA * decisionB * decisionC) / 1_000_000;
  const expectedPayout = Math.floor(baseYield * multiplier);
  const managerCut = Math.floor(expectedPayout * 0.8);
  const treasuryCut = expectedPayout - managerCut;

  if (!walletInstalled) {
    return (
      <Card className="w-full p-4">
        <div className="mb-2">
          <h2 className="text-xl font-bold">Manage a Development (Minalia toy)</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Install Auro Wallet to run a development.
          </p>
        </div>
        <Button
          size="lg"
          className="mt-2 w-full"
          onClick={() => window.open("https://www.aurowallet.com", "_blank")}
        >
          Install Auro Wallet
        </Button>
      </Card>
    );
  }

  if (!wallet) {
    return (
      <Card className="w-full p-4">
        <div className="mb-2">
          <h2 className="text-xl font-bold">Manage a Development (Minalia toy)</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Connect your wallet to take over a development.
          </p>
        </div>
        <Button size="lg" className="mt-2 w-full" onClick={onConnectWallet}>
          Connect wallet
        </Button>
      </Card>
    );
  }

  return (
    <Card className="w-full p-4">
      <div className="mb-2">
        <h2 className="text-xl font-bold">Manage a Development (Minalia toy)</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Run a Minalia development that pays yield in one of the five in-game tokens.
        </p>
      </div>

      {/* IN-GAME BALANCES */}
      <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3">
        <p className="text-xs uppercase tracking-wide text-amber-700">
          In-game balances (Protokit appchain)
        </p>
        <div className="mt-2 grid grid-cols-5 gap-2 text-center">
          {MINALIA_TOKENS.map(({ symbol }) => (
            <div key={symbol} className="rounded bg-amber-100 p-2">
              <p className="text-xs font-medium text-amber-700">{symbol}</p>
              <p className="text-sm font-bold text-amber-900">
                {fmtBalance(balances[symbol])}
              </p>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-amber-700">
          Updates after each successful tick. Bridge to Zeko TBD.
        </p>
      </div>

      <Form {...form}>
        {/* DEV PICKER */}
        <div className="mt-4 rounded-md border bg-zinc-50 p-3">
          <FormField
            name="devId"
            render={() => (
              <FormItem>
                <FormLabel>Which development?</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    step={1}
                    value={devId}
                    onChange={(e) => setDevId(Math.floor(Number(e.target.value)))}
                  />
                </FormControl>
              </FormItem>
            )}
          />
          <p className="mt-2 text-xs text-zinc-500">
            Each number is an independent development with its own state.
          </p>
        </div>

        {/* STEP 1 — OPEN */}
        <div className="mt-4 rounded-md border p-3">
          <p className="mb-2 text-sm font-medium">Step 1 — Open development #{devId}</p>
          <p className="mb-3 text-xs text-zinc-500">
            Choose which token this development pays out in, the headline yield per payday,
            and how many days between paydays.
          </p>

          <div className="mb-3">
            <FormLabel>Yield token</FormLabel>
            <Select
              value={yieldToken}
              onValueChange={(v) => setYieldToken(v as MinaliaTokenSymbol)}
            >
              <SelectTrigger className="mt-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MINALIA_TOKENS.map(({ symbol }) => (
                  <SelectItem key={symbol} value={symbol}>
                    {symbol}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <FormField
              name="baseYield"
              render={() => (
                <FormItem>
                  <FormLabel>Headline yield per payday</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step={1}
                      value={baseYield}
                      onChange={(e) => setBaseYield(Math.floor(Number(e.target.value)))}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              name="cycleLength"
              render={() => (
                <FormItem>
                  <FormLabel>Days between paydays</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step={1}
                      value={cycleLength}
                      onChange={(e) => setCycleLength(Math.floor(Number(e.target.value)))}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
          </div>

          <Button
            size="lg"
            type="button"
            className="mt-3 w-full"
            loading={loading}
            onClick={() => onInitialiseDev(devId, yieldToken, baseYield, cycleLength)}
          >
            Open development #{devId} ({yieldToken})
          </Button>
        </div>

        {/* STEP 2 — DECISIONS */}
        <div className="mt-4 rounded-md border p-3">
          <p className="mb-2 text-sm font-medium">Step 2 — Make management decisions for #{devId}</p>
          <p className="mb-3 text-xs text-zinc-500">
            Three decisions affect performance.
            <br />
            <span className="text-zinc-700">100 = baseline. 150 = aggressive (+50%). 80 = cautious (−20%).</span>
            <br />
            Allowed range: 50 to 200.
          </p>
          <div className="grid grid-cols-3 gap-3">
            <FormField
              name="decisionA"
              render={() => (
                <FormItem>
                  <FormLabel>Recipe</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step={1}
                      value={decisionA}
                      onChange={(e) => setDecisionA(Math.floor(Number(e.target.value)))}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              name="decisionB"
              render={() => (
                <FormItem>
                  <FormLabel>Sourcing</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step={1}
                      value={decisionB}
                      onChange={(e) => setDecisionB(Math.floor(Number(e.target.value)))}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              name="decisionC"
              render={() => (
                <FormItem>
                  <FormLabel>Hours</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step={1}
                      value={decisionC}
                      onChange={(e) => setDecisionC(Math.floor(Number(e.target.value)))}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
          </div>
          <Button
            size="lg"
            type="button"
            className="mt-3 w-full"
            loading={loading}
            onClick={() => onUpdateDecisions(devId, decisionA, decisionB, decisionC)}
          >
            Submit decisions for #{devId}
          </Button>

          <div className="mt-3 rounded-md bg-zinc-50 p-2 text-xs text-zinc-700">
            <p>
              Combined effect: <strong>×{multiplier.toFixed(3)}</strong>
            </p>
            <p>
              Expected payday: <strong>{expectedPayout}</strong> tokens
              {" "}(<strong>{managerCut}</strong> to you as manager,{" "}
              <strong>{treasuryCut}</strong> to treasury)
            </p>
          </div>
        </div>

        {/* STEP 3 — ADVANCE TIME */}
        <div className="mt-4 rounded-md border p-3">
          <p className="mb-2 text-sm font-medium">Step 3 — Advance one day for #{devId}</p>
          <p className="mb-3 text-xs text-zinc-500">
            After {cycleLength} day{cycleLength === 1 ? "" : "s"} pass, the development pays
            in its yield token (80% manager, 20% treasury — both you here).
          </p>
          <Button
            size="lg"
            type="button"
            className="w-full"
            loading={loading}
            onClick={() => onTick(devId)}
          >
            Advance one day (development #{devId})
          </Button>
        </div>
      </Form>
    </Card>
  );
}
