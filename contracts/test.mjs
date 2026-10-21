// Self-check for Pact.cash: the oracle's signature can only pay the owner or the beneficiary.
// Run: npm test
import assert from 'node:assert/strict';
import { compileFile } from 'cashc';
import { Contract, MockNetworkProvider, TransactionBuilder, randomUtxo } from 'cashscript';
import { secp256k1, sha256, hash160, hexToBin, binToHex, generatePrivateKey, encodeCashAddress } from '@bitauth/libauth';

const artifact = compileFile(new URL('./Pact.cash', import.meta.url));
const key = () => { const priv = generatePrivateKey(); return { priv, pkh: hash160(secp256k1.derivePublicKeyCompressed(priv)) }; };
const p2pkh = (pkh) => encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: pkh }).address;

const owner = key(), beneficiary = key(), thief = key(), oracle = key();
const oraclePk = secp256k1.derivePublicKeyCompressed(oracle.priv);
const DEADLINE = 1_800_000_000; // unix seconds (> 500M, so CLTV reads it as a timestamp)
const FEE = 1000n;
const STAKE = 100_000n;

const provider = new MockNetworkProvider();
const pact = new Contract(artifact, [owner.pkh, beneficiary.pkh, oraclePk, BigInt(DEADLINE), FEE], { provider });

// What the oracle signs: outpoint txid (internal byte order) || outpoint index (4-byte LE) || verdict.
export function verdictMessage(txid, vout, verdict) {
  const idx = new Uint8Array(4); new DataView(idx.buffer).setUint32(0, vout, true);
  return Uint8Array.from([...hexToBin(txid).reverse(), ...idx, verdict]);
}
const sign = (msg, priv = oracle.priv) => secp256k1.signMessageHashSchnorr(priv, sha256.hash(msg));

const fund = () => provider.addUtxo(pact.address, randomUtxo({ satoshis: STAKE }));
const settle = (utxo, sig, verdict, to, amount = STAKE - FEE) => new TransactionBuilder({ provider })
  .addInput(utxo, pact.unlock.settle(sig, Uint8Array.of(verdict)))
  .addOutput({ to, amount }).send();

// 1. Goal met: stake goes back to the owner.
let u = fund();
await settle(u, sign(verdictMessage(u.txid, u.vout, 1)), 1, p2pkh(owner.pkh));

// 2. Goal missed: stake goes to the beneficiary.
u = fund();
await settle(u, sign(verdictMessage(u.txid, u.vout, 0)), 0, p2pkh(beneficiary.pkh));

// 3. A valid "met" verdict still can't redirect the stake to anyone else.
u = fund();
await assert.rejects(settle(u, sign(verdictMessage(u.txid, u.vout, 1)), 1, p2pkh(thief.pkh)));
await assert.rejects(settle(u, sign(verdictMessage(u.txid, u.vout, 1)), 1, p2pkh(beneficiary.pkh)));

// 4. Can't flip the verdict, replay it on another pact, or forge it with another key.
await assert.rejects(settle(u, sign(verdictMessage(u.txid, u.vout, 0)), 1, p2pkh(owner.pkh)));
const other = fund();
await assert.rejects(settle(u, sign(verdictMessage(other.txid, other.vout, 1)), 1, p2pkh(owner.pkh)));
await assert.rejects(settle(u, sign(verdictMessage(u.txid, u.vout, 1), thief.priv), 1, p2pkh(owner.pkh)));
await assert.rejects(settle(u, sign(verdictMessage(u.txid, u.vout, 2)), 2, p2pkh(owner.pkh)));

// 5. Can't skim: the payout must be exactly stake - fee, in a single output.
await assert.rejects(settle(u, sign(verdictMessage(u.txid, u.vout, 1)), 1, p2pkh(owner.pkh), STAKE - FEE - 5000n));
await assert.rejects(new TransactionBuilder({ provider })
  .addInput(u, pact.unlock.settle(sign(verdictMessage(u.txid, u.vout, 1)), Uint8Array.of(1)))
  .addOutput({ to: p2pkh(owner.pkh), amount: STAKE - FEE - 5000n })
  .addOutput({ to: p2pkh(thief.pkh), amount: 4000n }).send());

// 6. No verdict: after the deadline anyone can send the stake to the beneficiary, never before.
const expire = (utxo, locktime, to) => new TransactionBuilder({ provider })
  .addInput(utxo, pact.unlock.expire()).addOutput({ to, amount: STAKE - FEE }).setLocktime(locktime).send();
await assert.rejects(expire(u, DEADLINE - 1, p2pkh(beneficiary.pkh)));
await assert.rejects(expire(u, DEADLINE, p2pkh(owner.pkh)));
await expire(u, DEADLINE, p2pkh(beneficiary.pkh));

console.log(`Pact OK: ${pact.address} (${pact.bytesize} bytes, ${pact.opcount} ops)`);
