// All runtime settings come from Vite env vars (see .env.example). Placeholders until the user sets them.
const env = import.meta.env;

export const NETWORK = env.VITE_NETWORK === 'mainnet' ? 'mainnet' : 'chipnet';
export const FEE_ADDRESS = env.VITE_FEE_ADDRESS || '';
export const BANNER = {
  slides: env.VITE_SLIDES_URL || 'https://docs.google.com/presentation/d/1yXUD5-sunwF_ce6cGEhgT21e3LL5kCHk7FhXlBAhYN4/edit?usp=sharing',
  repo: env.VITE_REPO_URL || 'https://github.com/cyberhooman/pact-blaze',
  vote: env.VITE_VOTE_ADDRESS || 'bitcoincash:zpr2waldp42mzs2wquq26v6vy6ks7n8dvcl9x3pt8l',
  // BLAZE rule: pre-existing work shows its before demo and before code next to the new ones.
  beforeDemo: 'https://bchblaze-pact.vercel.app',
  beforeCode: 'https://github.com/cyberhooman/pact-blaze/tree/before-blaze',
  changes: 'https://github.com/cyberhooman/pact-blaze/blob/main/CHANGELOG.md',
};
// "Label=address,Label=address". Empty addresses show as disabled chips.
export const BENEFICIARIES = (env.VITE_BENEFICIARIES || 'A charity=,A friend=')
  .split(',').map((s) => s.split('=')).map(([label, address]) => ({ label: label.trim(), address: (address || '').trim() }));
export const FALLBACK_BCH_USD = Number(env.VITE_BCH_USD || 400);
// The dollar token you can stake: PUSD on mainnet; on chipnet a test token we minted (VITE_TEST_TOKEN), else none.
const PUSD_CATEGORY = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
export const STAKE_TOKEN = NETWORK === 'mainnet'
  ? { category: PUSD_CATEGORY, decimals: 2, symbol: 'PUSD' }
  : env.VITE_TEST_TOKEN ? { category: env.VITE_TEST_TOKEN, decimals: 2, symbol: 'tPUSD' } : null;

export const explorerTx = (txid) => (NETWORK === 'mainnet'
  ? `https://blockchair.com/bitcoin-cash/transaction/${txid}`
  : `https://chipnet.imaginary.cash/tx/${txid}`);
export const explorerAddress = (addr) => (NETWORK === 'mainnet'
  ? `https://blockchair.com/bitcoin-cash/address/${addr.replace(/^bitcoincash:/, '')}`
  : `https://chipnet.imaginary.cash/address/${addr}`);
