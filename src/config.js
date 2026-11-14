// All runtime settings come from Vite env vars (see .env.example). Placeholders until the user sets them.
const env = import.meta.env;

export const NETWORK = env.VITE_NETWORK === 'mainnet' ? 'mainnet' : 'chipnet';
export const FEE_ADDRESS = env.VITE_FEE_ADDRESS || '';
export const BANNER = {
  slides: env.VITE_SLIDES_URL || '#slides-coming-soon',
  repo: env.VITE_REPO_URL || 'https://github.com/cyberhooman/pact-blaze',
  vote: env.VITE_VOTE_ADDRESS || 'bitcoincash:zVOTE-ADDRESS-PLACEHOLDER',
};
// "Label=address,Label=address". Empty addresses show as disabled chips.
export const BENEFICIARIES = (env.VITE_BENEFICIARIES || 'A charity=,A friend=')
  .split(',').map((s) => s.split('=')).map(([label, address]) => ({ label: label.trim(), address: (address || '').trim() }));
export const FALLBACK_BCH_USD = Number(env.VITE_BCH_USD || 400);

export const explorerTx = (txid) => (NETWORK === 'mainnet'
  ? `https://blockchair.com/bitcoin-cash/transaction/${txid}`
  : `https://chipnet.imaginary.cash/tx/${txid}`);
export const explorerAddress = (addr) => (NETWORK === 'mainnet'
  ? `https://blockchair.com/bitcoin-cash/address/${addr.replace(/^bitcoincash:/, '')}`
  : `https://chipnet.imaginary.cash/address/${addr}`);
