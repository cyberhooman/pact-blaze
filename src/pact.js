// Pact transaction helpers: pure, shared by the app and the tests.
import { Contract, ElectrumNetworkProvider, TransactionBuilder, placeholderP2PKHUnlocker, placeholderPublicKey, placeholderSignature } from 'cashscript';
import { encodeCashAddress, decodeCashAddress, hexToBin, binToHex, stringify, decodeTransactionUnsafe, encodeTransaction, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import artifact from './Pact.json' with { type: 'json' };

export const SETTLE_FEE = 1000n;   // covenant tx fee, paid from the stake on release/forfeit/expire
export const DUST = 546n;
export const MAX_GOAL_BYTES = 120;
export const TOKEN_SATS = 2000n;   // BCH riding on a token stake: pays the settle fee, leaves 1,000 for the token payout
export const TOKEN_DUST = 1000n;   // BCH on the token fee output and token change (token outputs need ~650+)
export const MIN_TOKEN_STAKE = 50n; // token base units (PUSD has 2 decimals: 0.50 PUSD)
// PUSD on mainnet (paryonusd.com/blog/launch). Chipnet has no PUSD; the e2e script mints its own test token.
export const PUSD = { category: '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544', decimals: 2, symbol: 'PUSD' };
const FEE_RATE = 1;                // sats/byte for the funding tx
const FUNDING_MARGIN = 2000n;      // enough miner fee for a funding tx with several inputs

// CashScript's default chipnet server (chipnet.bch.ninja) refused connections on 2026-10-21; imaginary.cash answered.
export const chainProvider = (network) =>
  new ElectrumNetworkProvider(network, network === 'chipnet' ? { hostname: 'chipnet.imaginary.cash' } : undefined);

export const prefixOf = (network) => (network === 'mainnet' ? 'bitcoincash' : 'bchtest');
export const pkhAddress = (pkh, network) =>
  encodeCashAddress({ prefix: prefixOf(network), type: 'p2pkh', payload: typeof pkh === 'string' ? hexToBin(pkh) : pkh }).address;

// Flat 1% platform fee: in sats never below dust, in tokens never below 1 unit.
export const platformFee = (stake) => (stake / 100n > DUST ? stake / 100n : DUST);
export const tokenFee = (stake) => (stake / 100n > 0n ? stake / 100n : 1n);

// The token-aware (z...) form of a P2PKH address, where token outputs must go.
export const tokenAddressOf = (address) => {
  const d = decodeCashAddress(address);
  if (typeof d === 'string') throw new Error(d);
  return encodeCashAddress({ prefix: d.prefix, type: 'p2pkhWithTokens', payload: d.payload }).address;
};

export function makePact({ ownerPkh, beneficiaryPkh, oraclePk, deadline, fee = SETTLE_FEE }, provider) {
  const bin = (x) => (typeof x === 'string' ? hexToBin(x) : x);
  return new Contract(artifact, [bin(ownerPkh), bin(beneficiaryPkh), bin(oraclePk), BigInt(deadline), BigInt(fee)], { provider });
}

// Funding tx: stake -> contract, 1% -> fee address, OP_RETURN note, change.
// With `token` ({category}), the stake and the 1% are in that token's base units, and the BCH only pays
// for the outputs that carry it. Note: PACT <goal> <deadline> <beneficiaryPkh> <oraclePk> <ownerPkh>, so
// anyone reading the fee address's history can rebuild every pact (the public feed), and the owner's wallet
// can rebuild its own on any device.
// utxos: [{txid, vout, satoshis, token?, address, path: "receive"|"change", index}] from the user's wallet.
// unlockerFor defaults to a wallet placeholder; tests pass a real signer.
export function buildFunding({ utxos, contract, stake, goal, deadline, feeAddress, changeAddress, provider, token,
  unlockerFor = (u) => placeholderP2PKHUnlocker(u.address) }) {
  stake = BigInt(stake);
  if (!token && stake < 10_000n) throw new Error('Stake must be at least 10,000 sats.');
  if (token && stake < MIN_TOKEN_STAKE) throw new Error(`Stake must be at least ${MIN_TOKEN_STAKE} token units.`);
  const goalBytes = new TextEncoder().encode(goal);
  if (!goalBytes.length || goalBytes.length > MAX_GOAL_BYTES) throw new Error(`Goal must be 1-${MAX_GOAL_BYTES} bytes.`);
  const fee = token ? tokenFee(stake) : platformFee(stake);
  const biggestFirst = (key) => (a, b) => (key(b) > key(a) ? 1 : key(b) < key(a) ? -1 : 0);

  const picked = [];
  let tokens = 0n;
  if (token) {
    for (const u of utxos.filter((u) => u.token?.category === token.category && !u.token.nft).sort(biggestFirst((u) => u.token.amount))) {
      if (tokens >= stake + fee) break;
      picked.push(u); tokens += u.token.amount;
    }
    if (tokens < stake + fee) throw new Error(`Not enough ${token.symbol ?? 'tokens'}: need ${stake + fee} units, wallet has ${tokens}.`);
  }
  const tokenChange = tokens - stake - fee;
  const need = (token ? TOKEN_SATS + TOKEN_DUST + (tokenChange > 0n ? TOKEN_DUST : 0n) : stake + fee) + FUNDING_MARGIN;
  let total = picked.reduce((t, u) => t + u.satoshis, 0n);
  for (const u of utxos.filter((u) => !u.token).sort(biggestFirst((u) => u.satoshis))) {
    if (total >= need) break;
    picked.push(u); total += u.satoshis;
  }
  if (total < need) throw new Error(`Not enough BCH: need ${need} sats, wallet has ${total}.`);

  const builder = new TransactionBuilder({ provider });
  picked.forEach((u) => builder.addInput(u, unlockerFor(u)));
  if (token) {
    builder
      .addOutput({ to: contract.tokenAddress, amount: TOKEN_SATS, token: { category: token.category, amount: stake } })
      .addOutput({ to: tokenAddressOf(feeAddress), amount: TOKEN_DUST, token: { category: token.category, amount: fee } });
  } else {
    builder
      .addOutput({ to: contract.address, amount: stake })
      .addOutput({ to: feeAddress, amount: fee });
  }
  const args = contract.encodedConstructorArgs;
  builder.addOpReturnOutput(['PACT', goal, String(deadline), `0x${binToHex(args[1])}`, `0x${binToHex(args[2])}`, `0x${binToHex(args[0])}`]);
  if (tokenChange > 0n) builder.addOutput({ to: tokenAddressOf(changeAddress), amount: TOKEN_DUST, token: { category: token.category, amount: tokenChange } });
  builder.addBchChangeOutputIfNeeded({ to: changeAddress, feeRate: FEE_RATE });
  const inputPaths = picked.map((u, i) => [i, u.path, u.index]);
  return { builder, inputPaths, fee, stakeVout: 0 };
}

// Read a funding tx's note: PACT <goal> <deadline> [<beneficiaryPkh> <oraclePk> [<ownerPkh>]]
// (pacts before 2026-10-22 lack the keys; pacts before BLAZE, 14 Nov, lack the owner).
export function readPactNote(bytecode) {
  if (bytecode[0] !== 0x6a) return null;
  const parts = [];
  for (let i = 1; i < bytecode.length;) {
    let n = bytecode[i++];
    if (n === 0x4c) n = bytecode[i++];
    else if (n > 0x4b) return null; // our notes only use direct pushes and PUSHDATA1
    parts.push(bytecode.slice(i, i + n)); i += n;
  }
  const text = (b) => new TextDecoder().decode(b);
  if (parts.length < 3 || text(parts[0]) !== 'PACT') return null;
  const note = { goal: text(parts[1]), deadline: Number(text(parts[2])) };
  if (parts[3]?.length === 20 && parts[4]?.length === 33) Object.assign(note, { beneficiaryPkh: binToHex(parts[3]), oraclePk: binToHex(parts[4]) });
  if (note.oraclePk && parts[5]?.length === 20) note.ownerPkh = binToHex(parts[5]);
  return note;
}

const cashAddress = (bytecode, network) => {
  const r = lockingBytecodeToCashAddress({ bytecode, prefix: prefixOf(network) });
  return typeof r === 'string' ? null : r.address;
};

// Rebuild a pact (share params) from its funding tx. The note names the owner (pacts from BLAZE on);
// for older ones ownerPkh is the wallet scanning its own history. When both exist they must agree.
// The rebuilt covenant must match output 0, or it isn't a pact (or not this owner's).
export function pactFromFunding(txHex, txid, ownerPkh, network, provider) {
  const tx = decodeTransactionUnsafe(hexToBin(txHex));
  const note = tx.outputs.map((o) => readPactNote(o.lockingBytecode)).find(Boolean);
  if (!note?.beneficiaryPkh || !Number.isInteger(note.deadline)) return null;
  if (ownerPkh && note.ownerPkh && ownerPkh !== note.ownerPkh) return null;
  const owner = note.ownerPkh ?? ownerPkh;
  if (!owner) return null;
  const params = { ownerPkh: owner, beneficiaryPkh: note.beneficiaryPkh, oraclePk: note.oraclePk, deadline: note.deadline, fee: SETTLE_FEE };
  const out = tx.outputs[0];
  if (cashAddress(out.lockingBytecode, network) !== makePact(params, provider).address) return null;
  const pact = { ...params, network, goal: note.goal, stake: out.valueSatoshis, txid, vout: 0 };
  if (out.token) Object.assign(pact, { stake: out.token.amount, token: { category: binToHex(out.token.category) } });
  return pact;
}

// 'live' (coin still at the covenant), 'returned' (paid to the owner), 'forfeited' (paid to the beneficiary),
// or 'pending' (not visible yet). history(address) returns Electrum get_history rows.
export async function pactStatus(p, provider, history) {
  const contract = makePact(p, provider);
  if ((await contract.getUtxos()).some((u) => u.txid === p.txid && u.vout === Number(p.vout))) return 'live';
  for (const h of await history(contract.address)) {
    if (h.tx_hash === p.txid) continue;
    const tx = decodeTransactionUnsafe(hexToBin(await provider.getRawTransaction(h.tx_hash)));
    if (!tx.inputs.some((i) => binToHex(i.outpointTransactionHash) === p.txid && i.outpointIndex === Number(p.vout))) continue;
    return cashAddress(tx.outputs[0].lockingBytecode, p.network) === pkhAddress(p.ownerPkh, p.network) ? 'returned' : 'forfeited';
  }
  return 'pending';
}

// What WizardConnect's manager.signTransaction() takes.
// WizardConnect relays plain JSON, so BigInt/Uint8Array go in libauth's extended-JSON form
// (`<bigint: Xn>`, `<Uint8Array: 0x..>`), which wallets decode; raw objects throw "Do not know how to serialize a BigInt".
export function fundingSignRequest(funding, userPrompt = 'Stake on your Pact') {
  const wc = funding.builder.generateWcTransactionObject({ broadcast: false, userPrompt });
  // The transaction itself goes as hex: Paytaca only reads hex there, Cashonize takes hex or an object.
  wc.transaction = binToHex(encodeTransaction(wc.transaction));
  return { transaction: JSON.parse(stringify(wc)), inputPaths: funding.inputPaths };
}

// One payout output: the stake minus the settle fee, plus the token (if any) to the payee's token address.
const payout = (pkh, utxo, fee, network) => (utxo.token
  ? { to: tokenAddressOf(pkhAddress(pkh, network)), amount: utxo.satoshis - BigInt(fee), token: utxo.token }
  : { to: pkhAddress(pkh, network), amount: utxo.satoshis - BigInt(fee) });

// Goal met: the oracle's signature releases the stake to the owner. No user signature needed.
export function buildRelease({ contract, utxo, sig, ownerPkh, network, provider, fee = SETTLE_FEE }) {
  return new TransactionBuilder({ provider })
    .addInput(utxo, contract.unlock.release(hexToBin(sig)))
    .addOutput(payout(ownerPkh, utxo, fee, network));
}

// Give up: the owner's wallet signs the stake over to the beneficiary. The owner key is receive/0.
// ownerPk/ownerSig default to wallet placeholders; tests pass a real key and SignatureTemplate.
export function buildForfeit({ contract, utxo, beneficiaryPkh, network, provider, fee = SETTLE_FEE,
  ownerPk = placeholderPublicKey(), ownerSig = placeholderSignature() }) {
  const builder = new TransactionBuilder({ provider })
    .addInput(utxo, contract.unlock.forfeit(ownerPk, ownerSig))
    .addOutput(payout(beneficiaryPkh, utxo, fee, network));
  return { builder, inputPaths: [[0, 'receive', 0]] };
}

export function forfeitSignRequest(forfeit, userPrompt = 'Give up: send the stake to your beneficiary') {
  return fundingSignRequest(forfeit, userPrompt);
}

// After the deadline anyone can send the stake to the beneficiary (nodes check locktime against MTP).
export function buildExpire({ contract, utxo, beneficiaryPkh, deadline, network, provider, fee = SETTLE_FEE }) {
  return new TransactionBuilder({ provider })
    .addInput(utxo, contract.unlock.expire())
    .addOutput(payout(beneficiaryPkh, utxo, fee, network))
    .setLocktime(Number(deadline));
}

// Share URL: every pact param lives in the hash, so there is no database.
const b64url = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

export function encodeShare(p) {
  return b64url(JSON.stringify({ ...p, stake: String(p.stake), fee: String(p.fee ?? SETTLE_FEE), token: p.token && { category: p.token.category } }));
}
export function decodeShare(hash) {
  const p = JSON.parse(unb64url(hash.replace(/^#/, '')));
  for (const k of ['ownerPkh', 'beneficiaryPkh', 'oraclePk', 'txid']) if (!/^[0-9a-f]+$/i.test(p[k] ?? '')) throw new Error(`Bad share link: ${k}`);
  if (p.token && !/^[0-9a-f]{64}$/i.test(p.token.category ?? '')) throw new Error('Bad share link: token');
  return { ...p, stake: BigInt(p.stake), fee: BigInt(p.fee), deadline: Number(p.deadline), vout: Number(p.vout) };
}
