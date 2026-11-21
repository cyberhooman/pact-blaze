// Funding/release/forfeit/expire helpers against MockNetworkProvider. No network. Run: npm test
import assert from 'node:assert/strict';
import { compileFile } from 'cashc';
import { MockNetworkProvider, SignatureTemplate, randomUtxo, placeholderPublicKey, placeholderSignature } from 'cashscript';
import { secp256k1, hash160, binToHex, hexToBin, generatePrivateKey, decodeTransactionUnsafe, cashAddressToLockingBytecode, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { makePact, readPactNote, pactFromFunding, pactStatus, buildFunding, fundingSignRequest, buildRelease, buildForfeit, forfeitSignRequest, buildExpire, platformFee, tokenFee, tokenAddressOf, pkhAddress, encodeShare, decodeShare, DUST, SETTLE_FEE, TOKEN_SATS, TOKEN_DUST } from '../src/pact.js';
import { oraclePubkey, signVerdict } from '../lib/oracle.js';
import artifact from '../src/Pact.json' with { type: 'json' };
import { parseExtendedJson } from '@wizardconnect/core';

// What the wallet sees: the request after the relay's plain JSON.stringify, decoded with WizardConnect's parser.
// The transaction itself travels as hex (Paytaca reads only hex there); decode it to check the contents.
const wire = (r) => {
  const w = parseExtendedJson(JSON.stringify(r.transaction));
  assert.equal(typeof w.transaction, 'string', 'transaction must be hex for Paytaca');
  return { ...w, transaction: decodeTransactionUnsafe(hexToBin(w.transaction)) };
};

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
assert.doesNotThrow(() => JSON.stringify(req)); // the relay sends plain JSON
const { transaction: tx, sourceOutputs } = wire(req);
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
assert.doesNotThrow(() => JSON.stringify(fReq));
const fWire = wire(fReq);
const unlock = binToHex(fWire.transaction.inputs[0].unlockingBytecode);
assert.ok(unlock.includes(binToHex(placeholderPublicKey())) && unlock.includes(binToHex(placeholderSignature())));
assert.equal(fWire.sourceOutputs[0].contract.abiFunction.name, 'forfeit');
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

// 7. "Your pacts": the funding note names beneficiary + oracle, so the owner's wallet can rebuild the pact from the chain.
let fund = await fundPact();
const fundHex = await provider.getRawTransaction(fund.txid);
const note = decodeTransactionUnsafe(hexToBin(fundHex)).outputs.map((o) => readPactNote(o.lockingBytecode)).find(Boolean);
assert.deepEqual(note, { goal: GOAL, deadline: DEADLINE, beneficiaryPkh: params.beneficiaryPkh, oraclePk: params.oraclePk, ownerPkh: params.ownerPkh });
assert.ok(binToHex(decodeTransactionUnsafe(hexToBin(fundHex)).outputs[2].lockingBytecode).length / 2 <= 223, 'note fits OP_RETURN limit');
// The feed reads pacts with no wallet at all: the note names the owner.
assert.equal(makePact(pactFromFunding(fundHex, fund.txid, null, N, provider), provider).address, contract.address);
const rebuilt = pactFromFunding(fundHex, fund.txid, params.ownerPkh, N, provider);
assert.equal(makePact(rebuilt, provider).address, contract.address);
assert.equal(rebuilt.goal, GOAL); assert.equal(rebuilt.stake, STAKE); assert.equal(rebuilt.txid, fund.txid);
assert.equal(pactFromFunding(fundHex, fund.txid, binToHex(feeKey.pkh), N, provider), null); // not this wallet's pact
const oldNote = Uint8Array.from([0x6a, 4, ...new TextEncoder().encode('PACT'), 2, ...new TextEncoder().encode('hi'), 10, ...new TextEncoder().encode(String(DEADLINE))]);
assert.deepEqual(readPactNote(oldNote), { goal: 'hi', deadline: DEADLINE }); // pre-2026-10-22 pacts: no beneficiary, not rebuildable
assert.equal(readPactNote(hexToBin('76a914' + '00'.repeat(20) + '88ac')), null);

// Status: live while the coin sits at the covenant, then who got it.
const ours = { ...rebuilt, network: N };
const history = (txids) => async () => txids.map((tx_hash) => ({ tx_hash }));
assert.equal(await pactStatus(ours, provider, history([])), 'live');
const returned = await buildRelease({ contract, utxo: fund, sig: signVerdict(oracleHex, fund.txid, 0), ...params, network: N, provider }).send();
assert.equal(await pactStatus(ours, provider, history([fund.txid, returned.txid])), 'returned');
fund = await fundPact();
const gone = await buildForfeit({ contract, utxo: fund, ...params, network: N, provider,
  ownerPk: secp256k1.derivePublicKeyCompressed(owner.priv), ownerSig: new SignatureTemplate(owner.priv) }).builder.send();
assert.equal(await pactStatus({ ...ours, txid: fund.txid }, provider, history([fund.txid, returned.txid, gone.txid])), 'forfeited');
assert.equal(await pactStatus({ ...ours, txid: 'ab'.repeat(32) }, provider, history([])), 'pending');

// 8. Token (PUSD) pacts: stake and 1% fee in the token, payouts carry it, the chain rebuilds it.
const CAT = 'cd'.repeat(32), TSTAKE = 300n, token = { category: CAT, symbol: 'PUSD' };
assert.equal(tokenFee(300n), 3n); assert.equal(tokenFee(50n), 1n);
const ownerTok = tokenAddressOf(ownerAddr);
const fundTokenPact = async (have = 1000n) => {
  provider.addUtxo(ownerTok, randomUtxo({ satoshis: 1000n, token: { category: CAT, amount: have } }));
  provider.addUtxo(ownerAddr, randomUtxo({ satoshis: 20_000n }));
  const utxos = [...await provider.getUtxos(ownerAddr), ...await provider.getUtxos(ownerTok)].map((u) => ({ ...u, address: ownerAddr, path: 'receive', index: 0 }));
  const f = buildFunding({ ...opts, utxos, stake: TSTAKE, token, unlockerFor: () => signer.unlockP2PKH() });
  const sent = await f.builder.send();
  const out = decodeTransactionUnsafe(hexToBin(sent.hex)).outputs;
  assert.equal(out[0].valueSatoshis, TOKEN_SATS); assert.equal(out[0].token.amount, TSTAKE);
  assert.equal(binToHex(out[0].token.category), CAT);
  assert.equal(lockingBytecodeToCashAddress({ bytecode: out[1].lockingBytecode, prefix: 'bchtest' }).address, feeAddress);
  assert.equal(out[1].token.amount, 3n); assert.equal(out[1].valueSatoshis, TOKEN_DUST);
  const tokensIn = f.builder.inputs.reduce((t, i) => t + (i.token?.amount ?? 0n), 0n);
  if (tokensIn > TSTAKE + 3n) assert.equal(out[3].token.amount, tokensIn - TSTAKE - 3n, 'token change back to the owner');
  else assert.ok(!out[3].token, 'exact amount: no token change');
  return { utxo: (await contract.getUtxos()).find((u) => u.txid === sent.txid && u.vout === 0), hex: sent.hex };
};
const tokenPayee = (hex) => {
  const [o] = decodeTransactionUnsafe(hexToBin(hex)).outputs;
  assert.equal(o.token.amount, TSTAKE); assert.equal(binToHex(o.token.category), CAT); assert.equal(o.valueSatoshis, TOKEN_SATS - SETTLE_FEE);
  return lockingBytecodeToCashAddress({ bytecode: o.lockingBytecode, prefix: 'bchtest' }).address;
};
let t = await fundTokenPact();
assert.equal(tokenPayee((await buildRelease({ contract, utxo: t.utxo, sig: signVerdict(oracleHex, t.utxo.txid, 0), ...params, network: N, provider }).send()).hex), ownerAddr);
t = await fundTokenPact();
assert.equal(tokenPayee((await buildForfeit({ contract, utxo: t.utxo, ...params, network: N, provider,
  ownerPk: secp256k1.derivePublicKeyCompressed(owner.priv), ownerSig: new SignatureTemplate(owner.priv) }).builder.send()).hex), pkhAddress(beneficiary.pkh, N));
t = await fundTokenPact(TSTAKE + 3n); // exact: no token change output
const tRebuilt = pactFromFunding(t.hex, t.utxo.txid, null, N, provider);
assert.deepEqual(tRebuilt.token, { category: CAT }); assert.equal(tRebuilt.stake, TSTAKE);
assert.equal(tokenPayee((await buildExpire({ contract, utxo: t.utxo, ...params, network: N, provider }).send()).hex), pkhAddress(beneficiary.pkh, N));
const tBack = decodeShare('#' + encodeShare({ ...tRebuilt, fee: SETTLE_FEE }));
assert.deepEqual(tBack.token, { category: CAT }); assert.equal(tBack.stake, TSTAKE);
assert.throws(() => buildFunding({ ...opts, utxos: [], stake: TSTAKE, token }), /Not enough PUSD/);
assert.throws(() => buildFunding({ ...opts, utxos: [], stake: 10n, token }), /at least 50/);

console.log(`pact OK: sign request, 1% fee, OP_RETURN, release, forfeit, expire, share link, your-pacts rebuild + status, feed rebuild, PUSD pacts`);
