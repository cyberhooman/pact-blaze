// WizardConnect wallet adapter: derive addresses from the wallet's xpubs, find UTXOs, sign, broadcast.
import { hash160, binToHex, decodeCashAddress } from '@bitauth/libauth';
import { pkhAddress, prefixOf, pactFromFunding } from './pact.js';

const SCAN = [['receive', 0, 10], ['change', 1, 5]]; // [path, childIndex, addresses to scan]

export function ownerOf(manager, network) {
  const pk = manager.getPubkey(0, 0n);
  if (!pk) throw new Error('Wallet sent no receive key.');
  const pkh = hash160(pk);
  return { pkh: binToHex(pkh), address: pkhAddress(pkh, network) };
}

function walletSlots(manager, network) {
  const slots = [];
  for (const [path, child, n] of SCAN) {
    for (let i = 0; i < n; i++) {
      const pk = manager.getPubkey(child, BigInt(i));
      if (pk) slots.push({ path, index: i, address: pkhAddress(hash160(pk), network) });
    }
  }
  return slots;
}

export async function walletUtxos(manager, provider, network) {
  const slots = walletSlots(manager, network);
  const lists = await Promise.all(slots.map((s) => provider.getUtxos(s.address)));
  return lists.flatMap((utxos, i) => utxos.map((u) => ({ ...u, ...slots[i] })));
}

export const electrumHistory = (provider) => (address) => provider.performRequest('blockchain.address.get_history', address);

// Every pact this wallet funded, rebuilt from the chain: works on any device, no account needed.
// ponytail: scans the newest 40 wallet txs; page further back if wallets get busy.
export async function walletPacts(manager, provider, network) {
  const owner = ownerOf(manager, network);
  const rows = (await Promise.all(walletSlots(manager, network).map((s) => electrumHistory(provider)(s.address)))).flat();
  const order = (h) => (h.height > 0 ? h.height : Infinity); // unconfirmed = newest
  const txids = [...new Set(rows.sort((a, b) => order(a) - order(b)).map((r) => r.tx_hash))].slice(-40);
  const raws = await Promise.all(txids.map((t) => provider.getRawTransaction(t)));
  return raws.map((hex, i) => pactFromFunding(hex, txids[i], owner.pkh, network, provider)).filter(Boolean);
}

export async function signAndSend(manager, provider, request) {
  const { signedTransaction, error } = await manager.signTransaction(request);
  if (error || !signedTransaction) throw new Error(error || 'Wallet did not sign.');
  return provider.sendRawTransaction(signedTransaction);
}

// Accepts "bchtest:q..." or bare "q..."; returns the P2PKH hash as hex.
export function parseP2pkh(input, network) {
  const raw = input.trim();
  const decoded = decodeCashAddress(raw.includes(':') ? raw : `${prefixOf(network)}:${raw}`);
  if (typeof decoded === 'string') throw new Error('Not a valid Bitcoin Cash address.');
  if (decoded.prefix !== prefixOf(network)) throw new Error(`Use a ${network} address (${prefixOf(network)}:...).`);
  if (decoded.type !== 'p2pkh') throw new Error('Use a regular (P2PKH) address, not a token or script address.');
  return binToHex(decoded.payload);
}
