// End-to-end check on real chipnet against a deployed oracle (default: the live site).
// Run: node scripts/e2e-chipnet.mjs [baseUrl]
// Uses a burner chipnet key kept in .env as E2E_PRIVKEY_HEX (created on first run, never printed).
// One photo check calls Claude (about 1-2 cents of API credit); everything else is free.
import { readFileSync, writeFileSync } from 'node:fs';
import { SignatureTemplate, TransactionBuilder } from 'cashscript';
import { secp256k1, hash160, binToHex, hexToBin, generatePrivateKey, decodeCashAddress } from '@bitauth/libauth';
import { chainProvider, makePact, buildFunding, buildRelease, buildForfeit, pkhAddress, SETTLE_FEE } from '../src/pact.js';

const BASE = process.argv[2] ?? 'https://bchblaze-pact.vercel.app';
const NET = 'chipnet';
const BENEFICIARY = 'bchtest:qregmr8wn2yzhg7wgxsdakkc93g7yh3anvnxaqskqf'; // tbch.googol.cash donation address
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const txLink = (id) => `https://chipnet.imaginary.cash/tx/${id}`;

const envUrl = new URL('../.env', import.meta.url);
let env = readFileSync(envUrl, 'utf8');
let priv = env.match(/^E2E_PRIVKEY_HEX=([0-9a-f]{64})$/m)?.[1];
if (!priv) {
  priv = binToHex(generatePrivateKey());
  writeFileSync(envUrl, `${env.replace(/\n?$/, '\n')}E2E_PRIVKEY_HEX=${priv}\n`);
}
const pk = secp256k1.derivePublicKeyCompressed(hexToBin(priv));
const ownerPkh = binToHex(hash160(pk));
const owner = pkhAddress(ownerPkh, NET);
const beneficiaryPkh = binToHex(decodeCashAddress(BENEFICIARY).payload);
const feeAddress = env.match(/^VITE_FEE_ADDRESS=(\S+)$/m)?.[1] || owner;
const provider = chainProvider(NET);
const signer = new SignatureTemplate(hexToBin(priv));

const coins = async () => (await provider.getUtxos(owner)).filter((u) => !u.token).map((u) => ({ ...u, address: owner }));
const have = (await coins()).reduce((s, u) => s + u.satoshis, 0n);
console.log(`Script wallet ${owner}: ${have} sats`);
if (have < 30_000n) {
  console.log('Send at least 30,000 chipnet sats to that address, then run this again.');
  process.exit(2);
}

const { oraclePubkey, photo } = await (await fetch(`${BASE}/api/judge`)).json();
console.log(`Oracle ${BASE}: key ${oraclePubkey.slice(0, 10)}..., photo judging ${photo ? 'on' : 'off'}`);
const judge = async (body) => {
  const r = await fetch(`${BASE}/api/judge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

let failed = 0;
const check = (name, pass, note = '') => { if (!pass) failed++; console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${note ? `  ${note}` : ''}`); };

async function stake(goal) {
  const deadline = Math.floor(Date.now() / 1000) + 86400;
  const contract = makePact({ ownerPkh, beneficiaryPkh, oraclePk: oraclePubkey, deadline, fee: SETTLE_FEE }, provider);
  const funding = buildFunding({ utxos: await coins(), contract, stake: 10_000n, goal, deadline, feeAddress,
    changeAddress: owner, provider, unlockerFor: () => signer.unlockP2PKH() });
  const { txid } = await funding.builder.send();
  let utxo;
  for (let i = 0; i < 20 && !utxo; i++) {
    utxo = (await contract.getUtxos()).find((u) => u.txid === txid);
    if (!utxo) await new Promise((r) => setTimeout(r, 1500));
  }
  check('stake lands in the covenant', Boolean(utxo), txLink(txid));
  return { contract, utxo, req: { txid, vout: utxo.vout, goal, deadline, ownerPkh, beneficiaryPkh, fee: String(SETTLE_FEE) } };
}

console.log('\n1. Stake, prove, release');
const p1 = await stake('drink a glass of water tonight');
let r = await judge({ ...p1.req, mode: 'sample', beneficiaryPkh: ownerPkh });
check('oracle refuses a pact described with the wrong terms', r.status === 404, `(${r.status})`);
if (photo) {
  r = await judge({ ...p1.req, mode: 'photo', image: PNG });
  check('Claude judges a blank photo: missed, unsigned', r.status === 200 && r.body.verdict === 'missed' && r.body.sig === null,
    `(${r.status}: ${r.body.reason ?? r.body.error})`);
}
r = await judge({ ...p1.req, mode: 'sample' });
const sig = r.body.sig;
check('sample proof is signed', r.status === 200 && /^[0-9a-f]{128}$/.test(sig ?? ''), `(${r.status})`);
let redirected = true;
try {
  await new TransactionBuilder({ provider }).addInput(p1.utxo, p1.contract.unlock.release(hexToBin(sig)))
    .addOutput({ to: BENEFICIARY, amount: p1.utxo.satoshis - SETTLE_FEE }).send();
} catch { redirected = false; }
check('the signature cannot pay anyone but the owner', !redirected);
const rel = await buildRelease({ contract: p1.contract, utxo: p1.utxo, sig, ownerPkh, network: NET, provider }).send();
check('release pays the owner', Boolean(rel.txid), txLink(rel.txid));
r = await judge({ ...p1.req, mode: 'sample' });
check('oracle refuses the settled pact', r.status === 404, `(${r.status})`);

console.log('\n2. Stake, give up');
const p2 = await stake('test give up');
const ff = await buildForfeit({ contract: p2.contract, utxo: p2.utxo, beneficiaryPkh, network: NET, provider,
  ownerPk: pk, ownerSig: signer }).builder.send();
check('owner-signed forfeit pays the beneficiary', Boolean(ff.txid), txLink(ff.txid));

console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
