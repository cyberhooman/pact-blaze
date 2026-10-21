// Self-check for Pact.cash: the oracle can only return the stake to its owner; only the owner
// (or the deadline) can send it to the beneficiary; nobody can send it anywhere else.
// Run: npm test
import assert from 'node:assert/strict';
import { compileFile } from 'cashc';
import { Contract, MockNetworkProvider, TransactionBuilder, SignatureTemplate, randomUtxo } from 'cashscript';
import { secp256k1, sha256, hash160, hexToBin, generatePrivateKey, encodeCashAddress } from '@bitauth/libauth';

const artifact = compileFile(new URL('./Pact.cash', import.meta.url));
const key = () => {
  const priv = generatePrivateKey(); const pk = secp256k1.derivePublicKeyCompressed(priv);
  return { priv, pk, pkh: hash160(pk) };
};
const p2pkh = (pkh) => encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: pkh }).address;

const owner = key(), beneficiary = key(), thief = key(), oracle = key();
const DEADLINE = 1_800_000_000; // unix seconds (> 500M, so CLTV reads it as a timestamp)
const FEE = 1000n;
const STAKE = 100_000n;

const provider = new MockNetworkProvider();
const pact = new Contract(artifact, [owner.pkh, beneficiary.pkh, oracle.pk, BigInt(DEADLINE), FEE], { provider });

// What the oracle signs: outpoint txid (internal byte order) || outpoint index (4-byte LE) || 0x01.
const verdictMessage = (txid, vout, verdict = 1) => {
  const idx = new Uint8Array(4); new DataView(idx.buffer).setUint32(0, vout, true);
  return Uint8Array.from([...hexToBin(txid).reverse(), ...idx, verdict]);
};
const sign = (msg, priv = oracle.priv) => secp256k1.signMessageHashSchnorr(priv, sha256.hash(msg));

const fund = () => provider.addUtxo(pact.address, randomUtxo({ satoshis: STAKE }));
const tx = (utxo, unlocker, outputs, locktime) => {
  const b = new TransactionBuilder({ provider }).addInput(utxo, unlocker).addOutputs(outputs);
  if (locktime !== undefined) b.setLocktime(locktime);
  return b.send();
};
const pay = (pkh, amount = STAKE - FEE) => [{ to: p2pkh(pkh), amount }];
const release = (u, sig, outputs) => tx(u, pact.unlock.release(sig), outputs);
const forfeit = (u, k, outputs) => tx(u, pact.unlock.forfeit(k.pk, new SignatureTemplate(k.priv)), outputs);

// 1. Goal met: the oracle's signature returns the stake to the owner.
let u = fund();
await release(u, sign(verdictMessage(u.txid, u.vout)), pay(owner.pkh));

// 2. A valid release signature can't pay the beneficiary, a thief, or skim into a second output.
u = fund();
const good = sign(verdictMessage(u.txid, u.vout));
await assert.rejects(release(u, good, pay(beneficiary.pkh)));
await assert.rejects(release(u, good, pay(thief.pkh)));
await assert.rejects(release(u, good, pay(owner.pkh, STAKE - FEE - 5000n)));
await assert.rejects(release(u, good, [...pay(owner.pkh, STAKE - FEE - 5000n), ...pay(thief.pkh, 4000n)]));
await assert.rejects(release(u, good, [...pay(owner.pkh), ...pay(thief.pkh, 546n)])); // skim the fee

// 3. Can't release with a "missed" message, a verdict for another pact, or another key.
const other = fund();
await assert.rejects(release(u, sign(verdictMessage(u.txid, u.vout, 0)), pay(owner.pkh)));
await assert.rejects(release(u, sign(verdictMessage(other.txid, other.vout)), pay(owner.pkh)));
await assert.rejects(release(u, sign(verdictMessage(u.txid, u.vout), thief.priv), pay(owner.pkh)));

// Two equal pacts spent together into one payout would burn a whole stake to miners.
const twinA = fund(), twinB = fund();
await assert.rejects(new TransactionBuilder({ provider })
  .addInput(twinA, pact.unlock.release(sign(verdictMessage(twinA.txid, twinA.vout))))
  .addInput(twinB, pact.unlock.release(sign(verdictMessage(twinB.txid, twinB.vout))))
  .addOutputs(pay(owner.pkh)).send());

// 4. Only the owner can give up, and giving up only pays the beneficiary.
await assert.rejects(forfeit(u, thief, pay(beneficiary.pkh)));
await assert.rejects(tx(u, pact.unlock.forfeit(owner.pk, new SignatureTemplate(thief.priv)), pay(beneficiary.pkh))); // owner's public key, thief's signature
await assert.rejects(forfeit(u, beneficiary, pay(beneficiary.pkh)));
await assert.rejects(forfeit(u, owner, pay(owner.pkh)));
await assert.rejects(forfeit(u, owner, pay(thief.pkh)));
await forfeit(u, owner, pay(beneficiary.pkh));

// 5. No release: after the deadline anyone can send the stake to the beneficiary, never before.
u = fund();
await assert.rejects(tx(u, pact.unlock.expire(), pay(beneficiary.pkh), DEADLINE - 1));
await assert.rejects(tx(u, pact.unlock.expire(), pay(owner.pkh), DEADLINE));
await tx(u, pact.unlock.expire(), pay(beneficiary.pkh), DEADLINE);

console.log(`Pact OK: ${pact.address} (${pact.bytesize} bytes, ${pact.opcount} ops)`);
