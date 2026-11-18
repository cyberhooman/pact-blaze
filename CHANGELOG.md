# Changelog: built during BCH BLAZE 2026

Hacking opened 14 Nov 2026, 14:13 UTC. Everything before that is the tag `before-blaze`.

- Before code: https://github.com/cyberhooman/pact-blaze/tree/before-blaze
- Before demo (chipnet, left as it was): https://bchblaze-pact.vercel.app
- Everything built during BLAZE: https://github.com/cyberhooman/pact-blaze/compare/before-blaze...main

Each line below is one thing built during BLAZE, with its commit.

## 14 Nov
- Fork from `before-blaze`. Repo link now points here. Changelog started.
- Contract v2: a stake can be a CashToken (PUSD). Every exit keeps the token's category, amount and NFT commitment, so one contract serves BCH and PUSD. Tests attack all three exits. `npm run mutate` removes each of the 25 rules in turn and the tests catch all 25. ([2c2ce07](https://github.com/cyberhooman/pact-blaze/commit/2c2ce07))
- PUSD pacts in the app logic: stake and 1% fee in the token, payouts carry it. The funding note now names the owner, so any pact can be rebuilt from the chain with no wallet (for the public feed). ([3d30e6b](https://github.com/cyberhooman/pact-blaze/commit/3d30e6b))
- Oracle: on mainnet, "Use sample proof" only opens tiny demo pacts (about $0.50 of BCH or 1 PUSD). Real pacts need a real photo. ([97e29af](https://github.com/cyberhooman/pact-blaze/commit/97e29af))
- End-to-end on real chipnet with a minted test token in place of PUSD: 20 of 20 checks pass. Token release: [b3d163a6](https://chipnet.imaginary.cash/tx/b3d163a6ba03b79db5d65175cc8d596380aacfd6e0fbdce8b157fdc2653e842b), token give-up: [1e325339](https://chipnet.imaginary.cash/tx/1e32533930cfe613309cc5186f4208e516885ab7786f134b32efd9b26de72086). ([c4ce055](https://github.com/cyberhooman/pact-blaze/commit/c4ce055))
- App: stake in BCH or PUSD (one switch). Amounts show in the token. "Use sample proof" only shows where the oracle accepts it. On chipnet the switch uses our test token (tPUSD), so anyone can try the flow free. ([ded4c11](https://github.com/cyberhooman/pact-blaze/commit/ded4c11))
- Banner: before demo, before code, what's new, and the CashTokens address for EMBER2026 votes and prizes. ([f6bc0f5](https://github.com/cyberhooman/pact-blaze/commit/f6bc0f5))
- Read-only mainnet check: Electrum answers, PUSD genesis found, pact addresses build with a new mainnet oracle key. ([dcb8672](https://github.com/cyberhooman/pact-blaze/commit/dcb8672))

## 18 Nov
- **Mainnet live.** https://pact-blaze.vercel.app now runs on Bitcoin Cash mainnet with its own oracle key (03e2efe6…d5c5). The beneficiary preset is Eat BCH's South Sudan address, read off eatbch.org. The before demo stays on chipnet.
- First mainnet pacts, scripted end to end against the live site (`node scripts/e2e.mjs --mainnet`), 11 of 11 checks pass ([a2018f5](https://github.com/cyberhooman/pact-blaze/commit/a2018f5)):
  - Stake: [5af8efcd](https://blockchair.com/bitcoin-cash/transaction/5af8efcd765f5f6060fe3f56be38f45a53856f514dbd5e66c6b73978553fe161). Claude turned down a blank photo, so nothing was signed. Sample proof was signed, and the release paid the owner: [72fdf119](https://blockchair.com/bitcoin-cash/transaction/72fdf1194241ef469ac2a77584cec15b63a15f017341f7c8967aedbe68cc9b12).
  - Stake: [b8face13](https://blockchair.com/bitcoin-cash/transaction/b8face1365e2cdd885ea43bda64c3e36e350ecfa8f8d7f96a3b66b05e9403280), then the owner gave up and the stake went to the beneficiary: [c4e2fcf8](https://blockchair.com/bitcoin-cash/transaction/c4e2fcf8ea72556394456978561b2b500dcee312cd49effb1db8cc9a6dc935d5).
