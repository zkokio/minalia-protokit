import { Balance, VanillaRuntimeModules } from "@proto-kit/library";
import { ModulesConfig } from "@proto-kit/common";
import { PrivateKey, PublicKey } from "o1js";

import { Balances } from "./modules/balances";
import { Withdrawals } from "./modules/withdrawals";
import { DevelopmentYield } from "./modules/developmentYield";
import { MinaliaTreasury } from "./modules/treasury";
import { MinaliaLedger } from "./modules/ledger";
import { MinaliaUnitRegistry } from "./modules/unitRegistry";
import { MinaliaTax } from "./modules/tax";
import { MinaliaSales } from "./modules/sales";
import { MinaliaDevelopmentRegistry } from "./modules/developmentRegistry";

// Authority public key for module admin operations (mint, burn,
// setSupplyCap, forceTransfer, assignMinister, registerUnit, etc).
// Read from environment so no private key is committed in source.
// The chain process and any test client must share the same
// MINALIA_AUTHORITY_PRIVATE_KEY env var.
//
// In production, this is replaced with a key derived from a secret-
// managed source (KMS, hardware wallet, etc).
function readAuthorityPublicKey(): PublicKey {
  const raw = process.env.MINALIA_AUTHORITY_PRIVATE_KEY;
  if (!raw) {
    throw new Error(
      "MINALIA_AUTHORITY_PRIVATE_KEY environment variable is not set. " +
        "Generate a key with: node -e \"import('o1js').then(o1js => " +
        "console.log(o1js.PrivateKey.random().toBase58()))\" and export it.",
    );
  }
  return PrivateKey.fromBase58(raw).toPublicKey();
}

export const AUTHORITY_PUB = readAuthorityPublicKey();

export const modules = VanillaRuntimeModules.with({
  Balances,
  Withdrawals,
  DevelopmentYield,
  MinaliaTreasury,
  MinaliaLedger,
  MinaliaUnitRegistry,
  MinaliaTax,
  MinaliaSales,
  MinaliaDevelopmentRegistry,
});

export const config: ModulesConfig<typeof modules> = {
  Balances: {
    totalSupply: Balance.from(10_000 * 1e9),
  },
  Withdrawals: {},
  DevelopmentYield: {},
  MinaliaTreasury: {
    authority: AUTHORITY_PUB,
  },
  MinaliaLedger: {},
  MinaliaUnitRegistry: {
    authority: AUTHORITY_PUB,
  },
  MinaliaTax: {},
  MinaliaSales: {},
  MinaliaDevelopmentRegistry: {},
};

export default {
  modules,
  config,
};
