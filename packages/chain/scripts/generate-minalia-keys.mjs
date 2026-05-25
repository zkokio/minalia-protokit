#!/usr/bin/env node
// Generates the full Minalia key set: 1 deployer + 1 king + 20 minister keys.
// Output: .env format, printed to stdout. Redirect to a file and store it
// somewhere safe. Never commit the resulting file.
//
// Usage:
//   node scripts/generate-minalia-keys.mjs > minalia-keys.env
//   chmod 600 minalia-keys.env
//
// To load before starting the chain:
//   set -a && source minalia-keys.env && set +a

import { PrivateKey } from 'o1js';

const TERRITORIES = [
  'LUM_01', 'LUM_02', 'LUM_03', 'LUM_04', 'LUM_05',
  'LUM_06', 'LUM_07', 'LUM_08', 'LUM_09', 'LUM_10',
  'LUM_11', 'LUM_12', 'LUM_13', 'LUM_14', 'LUM_15',
  'LUM_16', 'LUM_17', 'LUM_18', 'LUM_19', 'LUM_20',
];

function generate(label) {
  const priv = PrivateKey.random();
  const pub = priv.toPublicKey();
  return {
    label,
    privateKey: priv.toBase58(),
    publicKey: pub.toBase58(),
  };
}

const keys = [
  generate('DEPLOYER'),
  generate('KING'),
  ...TERRITORIES.map(t => generate(`MINISTER_${t}`)),
];

const stamp = new Date().toISOString();
console.log(`# MINALIA chain keys — generated ${stamp}`);
console.log(`# 1 deployer + 1 king + 20 ministers = ${keys.length} keys`);
console.log(`# STORE SECURELY. NEVER COMMIT THIS FILE.`);
console.log(``);

for (const k of keys) {
  console.log(`# ${k.label} public key: ${k.publicKey}`);
  console.log(`MINALIA_${k.label}_PRIVATE_KEY=${k.privateKey}`);
  console.log(``);
}

console.error(`Generated ${keys.length} keys. Public keys for reference:`);
for (const k of keys) {
  console.error(`  ${k.label.padEnd(20)} ${k.publicKey}`);
}
