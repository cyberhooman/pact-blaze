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
- **PUSD on mainnet.** Bought 3 PUSD on Cauldron with WizardConnect from Cashonize ([a921c50a](https://blockchair.com/bitcoin-cash/transaction/a921c50aefb92b7d9db9d8d45ed368887cfa7512ff41472ac4adaf91894f1a0f)), then sent 2.02 PUSD to the test wallet. Full mainnet run, 20 of 20 checks pass:
  - PUSD stake of 1.00: [6b9aad85](https://blockchair.com/bitcoin-cash/transaction/6b9aad850c56dfacda3349dce156c3c18d71158bd6f185997c9b78b9a56a5ab4). The covenant refused a payout that drops the token. The release gave the PUSD back to the owner: [4268658f](https://blockchair.com/bitcoin-cash/transaction/4268658f88c13793323d146bba5a6cd156e48a33664e6b06b8fc770d839ae45a).
  - PUSD stake of 1.00: [f85ce278](https://blockchair.com/bitcoin-cash/transaction/f85ce2782f4e6c0a6da109fb0c129adb9952c0ac6a5d849b7abdc8cb322d6ea5), then the owner gave up and the PUSD went to the beneficiary: [9695972f](https://blockchair.com/bitcoin-cash/transaction/9695972fcd7d46a79a274730c77157264864bf2b7582bb21d0c3e55e2e387cea).

## 21 Nov
- Settled share links say what happened: "Paid back" or "Paid to beneficiary", read from the covenant history. Before, a finished pact opened from a link just said Expired. ([ed4016b](https://github.com/cyberhooman/pact-blaze/commit/ed4016b))
- Anthropic key rotated on both demos. Timed 3 real Claude verdicts with the new key: 4.2 s, 4.8 s, 2.9 s.
- Screenshots for the BUIDL page in `docs/buidl/`.
- Slides deck filled from the Widget Factory template and linked in the banner ([03cd472](https://github.com/cyberhooman/pact-blaze/commit/03cd472)).
- My own pact on mainnet: 0.50 PUSD on "send my Pact entry to BCH BLAZE before Sunday 21:00" ([58e9ac2b](https://blockchair.com/bitcoin-cash/transaction/58e9ac2b515227b46b92d77aaa2e90a3e68b46c1b3c03e4a6d46ac78379630e9)). Submitted the BUIDL, uploaded a screenshot of it, Claude said met, paid back ([638ff0e2](https://blockchair.com/bitcoin-cash/transaction/638ff0e22d4709e2a3cf93fcdc953fcaeec115290214cb2cca19757cdfde607f)).
- Paytaca support: the WizardConnect sign request now sends the transaction as hex. Paytaca reads only hex there (src/wallet/wizardconnect/service.js), Cashonize takes hex or an object, so both wallets sign the same request. Tests check the hex form.
