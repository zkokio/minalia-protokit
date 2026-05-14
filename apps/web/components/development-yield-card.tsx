"use client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel } from "./ui/form";
import { useForm } from "react-hook-form";
import { Button } from "./ui/button";
import { useState } from "react";

export interface DevelopmentYieldCardProps {
  wallet?: string;
  walletInstalled: boolean;
  onConnectWallet: () => void;
  onInitialiseDev: (baseYield: number, cycleLength: number) => void;
  onUpdateDecisions: (a: number, b: number, c: number) => void;
  onTick: () => void;
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
  const [baseYield, setBaseYield] = useState(200);
  const [cycleLength, setCycleLength] = useState(5);
  const [decisionA, setDecisionA] = useState(115);
  const [decisionB, setDecisionB] = useState(100);
  const [decisionC, setDecisionC] = useState(100);

  if (!walletInstalled) {
    return (
      <Card className="w-full p-4">
        <div className="mb-2">
          <h2 className="text-xl font-bold">Development Yield (Toy)</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Install Auro Wallet to interact with this module.
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
          <h2 className="text-xl font-bold">Development Yield (Toy)</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Connect your wallet to test the toy development module.
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
        <h2 className="text-xl font-bold">Development Yield (Toy)</h2>
        <p className="mt-1 text-sm text-zinc-500">
          A toy Minalia development that pays yield each cycle.
          You are both manager and treasury for this test.
        </p>
      </div>

      <Form {...form}>
        {/* INITIALISE SECTION */}
        <div className="mt-4 rounded-md border p-3">
          <p className="mb-2 text-sm font-medium">Step 1 — Initialise</p>
          <p className="mb-3 text-xs text-zinc-500">
            Set up the development once. Choose a base yield per cycle and how many ticks count as a cycle.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <FormField
              name="baseYield"
              render={() => (
                <FormItem>
                  <FormLabel>Base yield</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      value={baseYield}
                      onChange={(e) => setBaseYield(Number(e.target.value))}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              name="cycleLength"
              render={() => (
                <FormItem>
                  <FormLabel>Cycle length (ticks)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      value={cycleLength}
                      onChange={(e) => setCycleLength(Number(e.target.value))}
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
            onClick={() => onInitialiseDev(baseYield, cycleLength)}
          >
            Initialise development
          </Button>
        </div>

        {/* DECISIONS SECTION */}
        <div className="mt-4 rounded-md border p-3">
          <p className="mb-2 text-sm font-medium">Step 2 — Update decisions</p>
          <p className="mb-3 text-xs text-zinc-500">
            Three decisions, each in basis points: 100 = ×1.00, 150 = ×1.50, 80 = ×0.80. Range 50–200.
          </p>
          <div className="grid grid-cols-3 gap-3">
            <FormField
              name="decisionA"
              render={() => (
                <FormItem>
                  <FormLabel>A</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      value={decisionA}
                      onChange={(e) => setDecisionA(Number(e.target.value))}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              name="decisionB"
              render={() => (
                <FormItem>
                  <FormLabel>B</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      value={decisionB}
                      onChange={(e) => setDecisionB(Number(e.target.value))}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              name="decisionC"
              render={() => (
                <FormItem>
                  <FormLabel>C</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      value={decisionC}
                      onChange={(e) => setDecisionC(Number(e.target.value))}
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
            onClick={() => onUpdateDecisions(decisionA, decisionB, decisionC)}
          >
            Update decisions
          </Button>
        </div>

        {/* TICK SECTION */}
        <div className="mt-4 rounded-md border p-3">
          <p className="mb-2 text-sm font-medium">Step 3 — Tick</p>
          <p className="mb-3 text-xs text-zinc-500">
            Advances one block. After {cycleLength} ticks, yield gets credited (80% to you as manager, 20% to you as treasury). Watch your balance grow.
          </p>
          <Button
            size="lg"
            type="button"
            className="w-full"
            loading={loading}
            onClick={onTick}
          >
            Tick once
          </Button>
        </div>
      </Form>
    </Card>
  );
}
