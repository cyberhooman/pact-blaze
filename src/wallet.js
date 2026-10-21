// WizardConnect wallet adapter: derive addresses from the wallet's xpubs, find UTXOs, sign, broadcast.
import { hash160, binToHex, decodeCashAddress } from '@bitauth/libauth';
import { pkhAddress, prefixOf } from './pact.js';

const SCAN = [['receive', 0, 10], ['change', 1, 5]]; // [path, childIndex, addresses to scan]

export function ownerOf(manager, network) {
  const pk = manager.getPubkey(0, 0n);
  if (!pk) throw new Error('Wallet sent no receive key.');
  const pkh = hash160(pk);
  return { pkh: binToHex(pkh), address: pkhAddress(pkh, network) };
}

export async function walletUtxos(manager, provider, network) {
  const slots = [];
  for (const [path, child, n] of SCAN) {
    for (let i = 0; i < n; i++) {
      const pk = manager.getPubkey(child, BigInt(i));
      if (pk) slots.push({ path, index: i, address: pkhAddress(hash160(pk), network) });
    }
  }
  const lists = await Promise.all(slots.map((s) => provider.getUtxos(s.address)));
  return lists.flatMap((utxos, i) => utxos.map((u) => ({ ...u, ...slots[i] })));
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
