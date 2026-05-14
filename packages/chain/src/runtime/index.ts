import { Balance, VanillaRuntimeModules } from "@proto-kit/library";
import { ModulesConfig } from "@proto-kit/common";

import { Balances } from "./modules/balances";
import { Withdrawals } from "./modules/withdrawals";
import { DevelopmentYield } from "./modules/developmentYield";

export const modules = VanillaRuntimeModules.with({
  Balances,
  Withdrawals,
  DevelopmentYield,
});

export const config: ModulesConfig<typeof modules> = {
  Balances: {
    totalSupply: Balance.from(10_000 * 1e9),
  },
  Withdrawals: {},
  DevelopmentYield: {},
};

export default {
  modules,
  config,
};
