// Print a fresh oracle keypair. Put the private key in Vercel env as ORACLE_PRIVKEY_HEX; never commit it.
import { generatePrivateKey, binToHex } from '@bitauth/libauth';
import { oraclePubkey } from '../lib/oracle.js';

const priv = binToHex(generatePrivateKey());
console.log(`ORACLE_PRIVKEY_HEX=${priv}`);
console.log(`# public key (published on every pact): ${oraclePubkey(priv)}`);
