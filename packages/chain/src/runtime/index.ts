import { Balance, VanillaRuntimeModules } from "@proto-kit/library";
import { ModulesConfig } from "@proto-kit/common";

import { Balances } from "./modules/balances";
import { Withdrawals } from "./modules/withdrawals";
import { DevelopmentYield } from "./modules/developmentYield";
import { MinaliaTreasury } from "./modules/treasury";
import { MinaliaLedger } from "./modules/ledger";
import { MinaliaUnitRegistry } from "./modules/unitRegistry";
import { MinaliaTax } from "./modules/tax";

export const modules = VanillaRuntimeModules.with({
  Balances,
  Withdrawals,
  DevelopmentYield,
  MinaliaTreasury,
  MinaliaLedger,
  MinaliaUnitRegistry,
  MinaliaTax,
});

export const config: ModulesConfig<typeof modules> = {
  Balances: {
    totalSupply: Balance.from(10_000 * 1e9),
  },
  Withdrawals: {},
  DevelopmentYield: {},
  MinaliaTreasury: {},
  MinaliaLedger: {},
  MinaliaUnitRegistry: {},
  MinaliaTax: {},
};

export default {
  modules,
  config,
};
