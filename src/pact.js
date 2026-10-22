// Pact transaction helpers: pure, shared by the app and the tests.
import { Contract, ElectrumNetworkProvider, TransactionBuilder, placeholderP2PKHUnlocker, placeholderPublicKey, placeholderSignature } from 'cashscript';
import { encodeCashAddress, hexToBin, binToHex, stringify, decodeTransactionUnsafe, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import artifact from './Pact.json' with { type: 'json' };

export const SETTLE_FEE = 1000n;   // covenant tx fee, paid from the stake on release/forfeit/expire
export const DUST = 546n;
export const MAX_GOAL_BYTES = 120;
const FEE_RATE = 1;                // sats/byte for the funding tx
const FUNDING_MARGIN = 2000n;      // enough miner fee for a funding tx with several inputs

// CashScript's default chipnet server (chipnet.bch.ninja) refused connections on 2026-10-21; imaginary.cash answered.
export const chainProvider = (network) =>
  new ElectrumNetworkProvider(network, network === 'chipnet' ? { hostname: 'chipnet.imaginary.cash' } : undefined);

export const prefixOf = (network) => (network === 'mainnet' ? 'bitcoincash' : 'bchtest');
export const pkhAddress = (pkh, network) =>
  encodeCashAddress({ prefix: prefixOf(network), type: 'p2pkh', payload: typeof pkh === 'string' ? hexToBin(pkh) : pkh }).address;

// Flat 1% platform fee, never below dust.
export const platformFee = (stake) => (stake / 100n > DUST ? stake / 100n : DUST);

export function makePact({ ownerPkh, beneficiaryPkh, oraclePk, deadline, fee = SETTLE_FEE }, provider) {
  const bin = (x) => (typeof x === 'string' ? hexToBin(x) : x);
  return new Contract(artifact, [bin(ownerPkh), bin(beneficiaryPkh), bin(oraclePk), BigInt(deadline), BigInt(fee)], { provider });
}

// Funding tx: stake -> contract, 1% -> fee address, OP_RETURN "PACT" <goal> <deadline>, change.
// utxos: [{txid, vout, satoshis, address, path: "receive"|"change", index}] from the user's wallet.
// unlockerFor defaults to a wallet placeholder; tests pass a real signer.
export function buildFunding({ utxos, contract, stake, goal, deadline, feeAddress, changeAddress, provider,
  unlockerFor = (u) => placeholderP2PKHUnlocker(u.address) }) {
  stake = BigInt(stake);
  if (stake < 10_000n) throw new Error('Stake must be at least 10,000 sats.');
  const goalBytes = new TextEncoder().encode(goal);
  if (!goalBytes.length || goalBytes.length > MAX_GOAL_BYTES) throw new Error(`Goal must be 1-${MAX_GOAL_BYTES} bytes.`);
  const fee = platformFee(stake);
  const need = stake + fee + FUNDING_MARGIN;

  const picked = [];
  let total = 0n;
  for (const u of [...utxos].filter((u) => !u.token).sort((a, b) => (b.satoshis > a.satoshis ? 1 : -1))) {
    if (total >= need) break;
    picked.push(u); total += u.satoshis;
  }
  if (total < need) throw new Error(`Not enough BCH: need ${need} sats, wallet has ${total}.`);

  const builder = new TransactionBuilder({ provider });
  picked.forEach((u) => builder.addInput(u, unlockerFor(u)));
  builder
    .addOutput({ to: contract.address, amount: stake })
    .addOutput({ to: feeAddress, amount: fee })
    // The note also names the beneficiary and oracle (constructor args 1 and 2), so the owner's wallet
    // can rebuild every pact it funded from the chain alone, on any device.
    .addOpReturnOutput(['PACT', goal, String(deadline),
      `0x${binToHex(contract.encodedConstructorArgs[1])}`, `0x${binToHex(contract.encodedConstructorArgs[2])}`])
    .addBchChangeOutputIfNeeded({ to: changeAddress, feeRate: FEE_RATE });
  const inputPaths = picked.map((u, i) => [i, u.path, u.index]);
  return { builder, inputPaths, fee, stakeVout: 0 };
}

// Read a funding tx's note: PACT <goal> <deadline> [<beneficiaryPkh> <oraclePk>] (pacts before 2026-10-22 lack the last two).
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
  return note;
}

const cashAddress = (bytecode, network) => {
  const r = lockingBytecodeToCashAddress({ bytecode, prefix: prefixOf(network) });
  return typeof r === 'string' ? null : r.address;
};

// Rebuild a pact (share params) from its funding tx. ownerPkh is the wallet scanning its own history;
// the note supplies the rest, and the rebuilt covenant must match output 0 or it isn't this owner's pact.
export function pactFromFunding(txHex, txid, ownerPkh, network, provider) {
  const tx = decodeTransactionUnsafe(hexToBin(txHex));
  const note = tx.outputs.map((o) => readPactNote(o.lockingBytecode)).find(Boolean);
  if (!note?.beneficiaryPkh || !Number.isInteger(note.deadline)) return null;
  const params = { ownerPkh, beneficiaryPkh: note.beneficiaryPkh, oraclePk: note.oraclePk, deadline: note.deadline, fee: SETTLE_FEE };
  if (cashAddress(tx.outputs[0].lockingBytecode, network) !== makePact(params, provider).address) return null;
  return { ...params, network, goal: note.goal, stake: tx.outputs[0].valueSatoshis, txid, vout: 0 };
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
  return { transaction: JSON.parse(stringify(wc)), inputPaths: funding.inputPaths };
}

// Goal met: the oracle's signature releases the stake to the owner. No user signature needed.
export function buildRelease({ contract, utxo, sig, ownerPkh, network, provider, fee = SETTLE_FEE }) {
  return new TransactionBuilder({ provider })
    .addInput(utxo, contract.unlock.release(hexToBin(sig)))
    .addOutput({ to: pkhAddress(ownerPkh, network), amount: utxo.satoshis - BigInt(fee) });
}

// Give up: the owner's wallet signs the stake over to the beneficiary. The owner key is receive/0.
// ownerPk/ownerSig default to wallet placeholders; tests pass a real key and SignatureTemplate.
export function buildForfeit({ contract, utxo, beneficiaryPkh, network, provider, fee = SETTLE_FEE,
  ownerPk = placeholderPublicKey(), ownerSig = placeholderSignature() }) {
  const builder = new TransactionBuilder({ provider })
    .addInput(utxo, contract.unlock.forfeit(ownerPk, ownerSig))
    .addOutput({ to: pkhAddress(beneficiaryPkh, network), amount: utxo.satoshis - BigInt(fee) });
  return { builder, inputPaths: [[0, 'receive', 0]] };
}

export function forfeitSignRequest(forfeit, userPrompt = 'Give up: send the stake to your beneficiary') {
  return fundingSignRequest(forfeit, userPrompt);
}

// After the deadline anyone can send the stake to the beneficiary (nodes check locktime against MTP).
export function buildExpire({ contract, utxo, beneficiaryPkh, deadline, network, provider, fee = SETTLE_FEE }) {
  return new TransactionBuilder({ provider })
    .addInput(utxo, contract.unlock.expire())
    .addOutput({ to: pkhAddress(beneficiaryPkh, network), amount: utxo.satoshis - BigInt(fee) })
    .setLocktime(Number(deadline));
}

// Share URL: every pact param lives in the hash, so there is no database.
const b64url = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

export function encodeShare(p) {
  return b64url(JSON.stringify({ ...p, stake: String(p.stake), fee: String(p.fee ?? SETTLE_FEE) }));
}
export function decodeShare(hash) {
  const p = JSON.parse(unb64url(hash.replace(/^#/, '')));
  for (const k of ['ownerPkh', 'beneficiaryPkh', 'oraclePk', 'txid']) if (!/^[0-9a-f]+$/i.test(p[k] ?? '')) throw new Error(`Bad share link: ${k}`);
  return { ...p, stake: BigInt(p.stake), fee: BigInt(p.fee), deadline: Number(p.deadline), vout: Number(p.vout) };
}
