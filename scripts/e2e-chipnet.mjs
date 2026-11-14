// End-to-end check on real chipnet against a deployed oracle (default: the BLAZE after-demo).
// Covers BCH pacts and token pacts (a test token minted once, since chipnet has no PUSD).
// Run: node scripts/e2e-chipnet.mjs [baseUrl]
// Uses a burner chipnet key kept in .env as E2E_PRIVKEY_HEX (created on first run, never printed).
// One photo check calls Claude (about 1-2 cents of API credit); everything else is free.
import { readFileSync, writeFileSync } from 'node:fs';
import { SignatureTemplate, TransactionBuilder } from 'cashscript';
import { secp256k1, hash160, binToHex, hexToBin, generatePrivateKey, decodeCashAddress } from '@bitauth/libauth';
import { chainProvider, makePact, buildFunding, buildRelease, buildForfeit, pkhAddress, pactFromFunding, tokenAddressOf, SETTLE_FEE } from '../src/pact.js';

const BASE = process.argv[2] ?? 'https://pact-blaze.vercel.app';
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const allCoins = async () => (await provider.getUtxos(owner)).map((u) => ({ ...u, address: owner }));

// A test token stands in for PUSD on chipnet. Minted once (genesis needs an input at vout 0), kept in .env.
async function testToken() {
  const saved = env.match(/^E2E_TOKEN_CATEGORY=([0-9a-f]{64})$/m)?.[1];
  if (saved) return saved;
  let seed = (await coins()).find((u) => u.vout === 0);
  if (!seed) { // make one: send to self so output 0 is ours
    const [u] = await coins();
    const { txid } = await new TransactionBuilder({ provider }).addInput(u, signer.unlockP2PKH())
      .addOutput({ to: owner, amount: u.satoshis - 500n }).send();
    for (let i = 0; i < 20 && !seed; i++) { seed = (await coins()).find((c) => c.txid === txid && c.vout === 0); if (!seed) await wait(1500); }
  }
  const { txid } = await new TransactionBuilder({ provider }).addInput(seed, signer.unlockP2PKH())
    .addOutput({ to: tokenAddressOf(owner), amount: 1000n, token: { category: seed.txid, amount: 1_000_000n } })
    .addOutput({ to: owner, amount: seed.satoshis - 1000n - 600n }).send();
  console.log(`Minted test token ${seed.txid.slice(0, 10)}... ${txLink(txid)}`);
  env = readFileSync(envUrl, 'utf8');
  writeFileSync(envUrl, `${env.replace(/\n?$/, '\n')}E2E_TOKEN_CATEGORY=${seed.txid}\n`);
  for (let i = 0; i < 20; i++) { if ((await allCoins()).some((c) => c.token?.category === seed.txid)) break; await wait(1500); }
  return seed.txid;
}

async function stake(goal, token) {
  const deadline = Math.floor(Date.now() / 1000) + 86400;
  const contract = makePact({ ownerPkh, beneficiaryPkh, oraclePk: oraclePubkey, deadline, fee: SETTLE_FEE }, provider);
  const funding = buildFunding({ utxos: await allCoins(), contract, stake: token ? 300n : 10_000n, goal, deadline, feeAddress,
    changeAddress: owner, provider, token, unlockerFor: () => signer.unlockP2PKH() });
  const { txid } = await funding.builder.send();
  let utxo;
  for (let i = 0; i < 20 && !utxo; i++) {
    utxo = (await contract.getUtxos()).find((u) => u.txid === txid);
    if (!utxo) await wait(1500);
  }
  check('stake lands in the covenant', Boolean(utxo), txLink(txid));
  const found = pactFromFunding(await provider.getRawTransaction(txid), txid, ownerPkh, NET, provider);
  check('the pact can be rebuilt from its funding tx alone', found && makePact(found, provider).address === contract.address);
  if (token) check('the stake is the token', utxo?.token?.category === token.category && utxo.token.amount === 300n, `(${utxo?.token?.amount} units)`);
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

console.log('\n3. Token pact (test token for PUSD): stake, prove, release; stake, give up');
const token = { category: await testToken(), symbol: 'TEST' };
const p3 = await stake('token pact: walk 10k steps', token);
r = await judge({ ...p3.req, mode: 'sample' });
check('sample proof is signed for a token pact', r.status === 200 && /^[0-9a-f]{128}$/.test(r.body.sig ?? ''), `(${r.status})`);
let stripped = true;
try {
  await new TransactionBuilder({ provider, allowImplicitFungibleTokenBurn: true }).addInput(p3.utxo, p3.contract.unlock.release(hexToBin(r.body.sig)))
    .addOutput({ to: owner, amount: p3.utxo.satoshis - SETTLE_FEE }).send();
} catch { stripped = false; }
check('the covenant refuses a payout that drops the token', !stripped);
const rel3 = await buildRelease({ contract: p3.contract, utxo: p3.utxo, sig: r.body.sig, ownerPkh, network: NET, provider }).send();
check('release returns the token to the owner', Boolean(rel3.txid), txLink(rel3.txid));
const p4 = await stake('token pact: test give up', token);
const ff4 = await buildForfeit({ contract: p4.contract, utxo: p4.utxo, beneficiaryPkh, network: NET, provider,
  ownerPk: pk, ownerSig: signer }).builder.send();
check('owner-signed forfeit sends the token to the beneficiary', Boolean(ff4.txid), txLink(ff4.txid));

console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
