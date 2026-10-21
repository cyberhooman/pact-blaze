// Funding/release/forfeit/expire helpers against MockNetworkProvider. No network. Run: npm test
import assert from 'node:assert/strict';
import { compileFile } from 'cashc';
import { MockNetworkProvider, SignatureTemplate, randomUtxo, placeholderPublicKey, placeholderSignature } from 'cashscript';
import { secp256k1, hash160, binToHex, hexToBin, generatePrivateKey, decodeTransactionUnsafe, cashAddressToLockingBytecode, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { makePact, buildFunding, fundingSignRequest, buildRelease, buildForfeit, forfeitSignRequest, buildExpire, platformFee, pkhAddress, encodeShare, decodeShare, DUST, SETTLE_FEE } from '../src/pact.js';
import { oraclePubkey, signVerdict } from '../lib/oracle.js';
import artifact from '../src/Pact.json' with { type: 'json' };

// 0. The committed browser artifact matches the contract source.
assert.equal(artifact.debug.bytecode, compileFile(new URL('../contracts/Pact.cash', import.meta.url)).debug.bytecode, 'run npm run compile');

const N = 'chipnet';
const key = () => { const priv = generatePrivateKey(); return { priv, pkh: hash160(secp256k1.derivePublicKeyCompressed(priv)) }; };
const owner = key(), beneficiary = key(), feeKey = key();
const oracleHex = binToHex(generatePrivateKey());
const DEADLINE = 1_800_000_000, GOAL = 'I will run 5 km before Sunday';
const ownerAddr = pkhAddress(owner.pkh, N), feeAddress = pkhAddress(feeKey.pkh, N);

const provider = new MockNetworkProvider();
const params = { ownerPkh: binToHex(owner.pkh), beneficiaryPkh: binToHex(beneficiary.pkh), oraclePk: oraclePubkey(oracleHex), deadline: DEADLINE };
const contract = makePact(params, provider);

// 1. Fee rules: flat 1%, never below dust.
assert.equal(platformFee(200_000n), 2000n);
assert.equal(platformFee(20_000n), DUST);

// 2. Wallet sign request shape from mock UTXOs (wallet placeholder inputs).
const ownerLock = binToHex(cashAddressToLockingBytecode(ownerAddr).bytecode);
const mine = (satoshis, path, index) => ({ ...randomUtxo({ satoshis }), lockingBytecode: ownerLock, address: ownerAddr, path, index });
const wallet = [mine(30_000n, 'receive', 0), mine(90_000n, 'change', 3), mine(5_000n, 'receive', 7)];
const STAKE = 100_000n;
const opts = { utxos: wallet, contract, stake: STAKE, goal: GOAL, deadline: DEADLINE, feeAddress, changeAddress: ownerAddr, provider };
const req = fundingSignRequest(buildFunding(opts));
assert.deepEqual(req.inputPaths, [[0, 'change', 3], [1, 'receive', 0]]); // largest first, stops when covered
const { transaction: tx, sourceOutputs } = req.transaction;
assert.equal(tx.inputs.length, 2); assert.equal(sourceOutputs.length, 2);
assert.equal(req.transaction.broadcast, false);
assert.equal(lockingBytecodeToCashAddress({ bytecode: tx.outputs[0].lockingBytecode, prefix: 'bchtest' }).address, contract.address);
assert.equal(tx.outputs[0].valueSatoshis, STAKE);
assert.equal(lockingBytecodeToCashAddress({ bytecode: tx.outputs[1].lockingBytecode, prefix: 'bchtest' }).address, feeAddress);
assert.equal(tx.outputs[1].valueSatoshis, 1000n);
const opret = binToHex(tx.outputs[2].lockingBytecode);
assert.ok(opret.startsWith('6a04' + binToHex(new TextEncoder().encode('PACT'))));
assert.ok(opret.includes(binToHex(new TextEncoder().encode(GOAL))) && opret.includes(binToHex(new TextEncoder().encode(String(DEADLINE)))));
assert.equal(tx.outputs[2].valueSatoshis, 0n);
const change = tx.outputs[3].valueSatoshis, minerFee = 120_000n - STAKE - 1000n - change;
assert.ok(change > DUST && minerFee > 0n && minerFee < 2000n, `miner fee ${minerFee}`);

// 3. Guard rails.
assert.throws(() => buildFunding({ ...opts, goal: 'x'.repeat(121) }), /1-120 bytes/);
assert.throws(() => buildFunding({ ...opts, stake: 200_000n }), /Not enough BCH/);
assert.throws(() => buildFunding({ ...opts, stake: 5_000n }), /at least/);

// 4. Round trip: fund (signed as the wallet would), then release (oracle) or forfeit (owner).
const signer = new SignatureTemplate(owner.priv);
const payee = (hex) => {
  const out = decodeTransactionUnsafe(hexToBin(hex)).outputs;
  assert.equal(out.length, 1); assert.equal(out[0].valueSatoshis, STAKE - SETTLE_FEE);
  return lockingBytecodeToCashAddress({ bytecode: out[0].lockingBytecode, prefix: 'bchtest' }).address;
};
const fundPact = async () => {
  provider.addUtxo(ownerAddr, randomUtxo({ satoshis: 200_000n }));
  const utxos = (await provider.getUtxos(ownerAddr)).map((u) => ({ ...u, address: ownerAddr, path: 'receive', index: 0 }));
  const { txid } = await buildFunding({ ...opts, utxos, unlockerFor: () => signer.unlockP2PKH() }).builder.send();
  const utxo = (await contract.getUtxos()).find((u) => u.txid === txid && u.vout === 0);
  assert.equal(utxo.satoshis, STAKE);
  return utxo;
};
let utxo = await fundPact();
const rel = await buildRelease({ contract, utxo, sig: signVerdict(oracleHex, utxo.txid, 0), ...params, network: N, provider }).send();
assert.equal(payee(rel.hex), ownerAddr);

// Forfeit: the wallet sign request carries placeholders for the owner key and signature at receive/0.
utxo = await fundPact();
const fReq = forfeitSignRequest(buildForfeit({ contract, utxo, ...params, network: N, provider }));
assert.deepEqual(fReq.inputPaths, [[0, 'receive', 0]]);
assert.equal(fReq.transaction.broadcast, false);
const unlock = binToHex(fReq.transaction.transaction.inputs[0].unlockingBytecode);
assert.ok(unlock.includes(binToHex(placeholderPublicKey())) && unlock.includes(binToHex(placeholderSignature())));
assert.equal(fReq.transaction.sourceOutputs[0].contract.abiFunction.name, 'forfeit');
// Signed for real (as the wallet would), it pays the beneficiary; a stranger's key can't.
const forfeitWith = (k) => buildForfeit({ contract, utxo, ...params, network: N, provider,
  ownerPk: secp256k1.derivePublicKeyCompressed(k.priv), ownerSig: new SignatureTemplate(k.priv) }).builder.send();
await assert.rejects(forfeitWith(feeKey));
assert.equal(payee((await forfeitWith(owner)).hex), pkhAddress(beneficiary.pkh, N));

// 5. Expire: only at/after the deadline, always to the beneficiary.
const u = provider.addUtxo(contract.address, randomUtxo({ satoshis: STAKE }));
const exp = buildExpire({ contract, utxo: u, beneficiaryPkh: params.beneficiaryPkh, deadline: DEADLINE, network: N, provider });
await exp.send();
await assert.rejects(buildExpire({ contract, utxo: provider.addUtxo(contract.address, randomUtxo({ satoshis: STAKE })), beneficiaryPkh: params.beneficiaryPkh, deadline: DEADLINE - 1, network: N, provider }).send());

// 6. Share link round trip rebuilds the same contract.
const share = { ...params, network: N, goal: GOAL, stake: STAKE, fee: SETTLE_FEE, txid: 'ab'.repeat(32), vout: 0 };
const back = decodeShare('#' + encodeShare(share));
assert.equal(back.goal, GOAL); assert.equal(back.stake, STAKE); assert.equal(back.deadline, DEADLINE);
assert.equal(makePact(back, provider).address, contract.address);
assert.throws(() => decodeShare(encodeShare({ ...share, txid: 'nope' })), /Bad share link/);

console.log(`pact OK: sign request, 1% fee, OP_RETURN, release, forfeit, expire, share link`);
