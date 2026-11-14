// Read-only mainnet check before launch day: the Electrum server answers, PUSD is where we think,
// the fee address reads, and a pact address builds with the mainnet oracle key. Moves no money.
// Creates ORACLE_PRIVKEY_HEX_MAINNET in .env on first run (never printed). Run: node scripts/mainnet-check.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { generatePrivateKey, binToHex, decodeCashAddress } from '@bitauth/libauth';
import { chainProvider, makePact, PUSD, SETTLE_FEE } from '../src/pact.js';
import { oraclePubkey } from '../lib/oracle.js';

const envUrl = new URL('../.env', import.meta.url);
let env = readFileSync(envUrl, 'utf8');
let priv = env.match(/^ORACLE_PRIVKEY_HEX_MAINNET=([0-9a-f]{64})$/m)?.[1];
if (!priv) {
  priv = binToHex(generatePrivateKey());
  writeFileSync(envUrl, `${env.replace(/\n?$/, '\n')}ORACLE_PRIVKEY_HEX_MAINNET=${priv}\n`);
  console.log('New mainnet oracle key saved to .env as ORACLE_PRIVKEY_HEX_MAINNET (not printed).');
}
const feeAddress = 'bitcoincash:qz9nz8fsnr55s3wzw3quau76u79mmhuxzyd7nku5c3';
const provider = chainProvider('mainnet');

const height = await provider.getBlockHeight();
console.log(`Mainnet Electrum answers: block ${height}`);
const feeUtxos = await provider.getUtxos(feeAddress);
console.log(`Fee address reads: ${feeUtxos.length} coins`);
const genesis = await provider.getRawTransaction(PUSD.category);
console.log(`PUSD genesis tx found (${genesis.length / 2} bytes)`);
const pkh = binToHex(decodeCashAddress(feeAddress).payload);
const pact = makePact({ ownerPkh: pkh, beneficiaryPkh: pkh, oraclePk: oraclePubkey(priv), deadline: 1_800_000_000, fee: SETTLE_FEE }, provider);
console.log(`Mainnet pact address builds: ${pact.address.slice(0, 24)}... (token form ${pact.tokenAddress.slice(0, 24)}...)`);
console.log(`Mainnet oracle public key: ${oraclePubkey(priv)}`);
process.exit(0);
