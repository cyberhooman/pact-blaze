# Pact: bet on yourself

**Stake BCH on your own goal. An AI checks your proof and signs a verdict. A covenant pays.**

> **The AI's only power is to give your money back. Only you, or the deadline, can send it to your beneficiary.**

You lock a little BCH in a Bitcoin Cash covenant and name a beneficiary (a friend or a charity). Before the deadline you upload a photo as proof. If Claude judges it *met*, the oracle signs this exact coin and the covenant returns the stake to you; that signature can't pay anyone else. If the photo isn't accepted, nothing is signed and you can try another. If you give up (your own wallet signs) or the deadline passes, the stake goes to your beneficiary.

## 30-second demo

1. Open the site and **Connect wallet** (WizardConnect; scan with Cashonize or Paytaca).
2. Type a goal ("I will run 5 km before Sunday"), pick a deadline, a $1 stake and a beneficiary address. Press **Stake** and approve once in the wallet.
3. On the pact page, either:
   - upload a photo (Claude judges it), or
   - press **Use sample proof (demo)**, which always passes, or
   - press **Give up**: your wallet signs once and the stake goes to your beneficiary.
4. On *met* the stamp shows Claude's reason and the oracle key that signed it, and the payout to you is broadcast automatically. A rejected photo shows the reason and "Try another photo before the deadline". Click the explorer link.

Every pact page is a share link: all the parameters live in the URL hash, so there's no database.

## How the covenant bounds the AI

`contracts/Pact.cash` (CashScript 0.14, 220 bytes) has three spending paths (simplified here):

```solidity
function release(datasig verdictSig) {   // the AI: goal met
    // oracle signed THIS coin's outpoint + 0x01, so no replay on another pact
    require(checkDataSig(verdictSig, outpointTxHash + outpointIndex + 0x01, oraclePk));
    require(tx.inputs.length == 1 && tx.outputs.length == 1);
    require(tx.outputs[0].lockingBytecode == new LockingBytecodeP2PKH(ownerPkh));
    require(tx.outputs[0].value == tx.inputs[this.activeInputIndex].value - fee);
}
function forfeit(pubkey ownerPk, sig ownerSig) {   // you: give up
    require(hash160(ownerPk) == ownerPkh && checkSig(ownerSig, ownerPk));
    /* same single-output check, to beneficiaryPkh */
}
function expire() {   // the clock: after the deadline anyone can pay the beneficiary
    require(tx.time >= deadline); /* same single-output check, to beneficiaryPkh */
}
```

- The oracle never holds funds. Its only power is to return the stake to the owner.
- The oracle signs only "met". A stranger can't get a signature that sends your stake to your beneficiary: that takes your own wallet signature (`forfeit`) or the deadline (`expire`).
- `release` needs no user signature: anyone holding the oracle's signature can broadcast the payout, so the app does it for you.
- The covenant fee is fixed (1000 sats), so nobody can skim the stake through miner fees.

## Threat model

| Risk | What happens |
|---|---|
| Owner fakes a proof photo | They only get their own money back. A cheater only cheats themselves. |
| Prompt injection in the photo or goal text | The system prompt treats both as untrusted data and defaults to *missed* when unsure. Even a fully fooled AI can only return the stake to its owner. Tested in `test/oracle.test.mjs`. |
| AI judges wrongly | A wrong *met* returns the owner's own money; a wrong *missed* sends nothing, so they can retry. Never theft. |
| Stranger tries to forfeit your pact | Impossible: the oracle never signs *missed*, and `forfeit` needs the owner's signature. |
| Oracle goes offline or loses its key | `expire` pays the beneficiary after the deadline with no oracle. Funds are never stuck. |
| Oracle key is stolen | The thief can only return stakes to their owners early. Upgrade path: a multisig oracle (several judges, 2-of-3). |
| Verdict replayed on another pact | The signature covers the exact outpoint, so it can't be. Tested in `contracts/test.mjs`. |

Note: on mainnet, `expire` becomes spendable about an hour after the deadline, because nodes compare locktime with median-time-past.

## Business

A flat **1% fee per pact** (min 546 sats), paid in the funding transaction. We never profit from your failure: forfeits go to your beneficiary, not to us. Next: coaches, gyms and teams create pacts for their clients.

## Run locally

```bash
npm install
npm test                       # covenant, oracle and tx-builder tests (no network)
cp .env.example .env           # then fill it in:
npm run oracle-key             #   ORACLE_PRIVKEY_HEX (keep it forever: pacts bind to its public key)
                               #   VITE_FEE_ADDRESS, optionally ANTHROPIC_API_KEY
npm run dev                    # http://localhost:5173, serves /api/judge too
```

Deploy: import the repo in Vercel and set the variables from `.env.example`. `vercel.json` builds the static site and the `/api/judge` function.

## Layout

| Path | What |
|---|---|
| `contracts/Pact.cash`, `contracts/test.mjs` | The covenant and its self-check |
| `lib/oracle.js`, `api/judge.js` | Oracle logic (Claude vision with a strict tool, Schnorr verdict signing) and the Vercel function |
| `src/pact.js` | Funding, release, forfeit and expire transactions, WizardConnect sign requests, share links |
| `src/wallet.js`, `src/App.jsx` | WizardConnect wallet adapter and the three screens |
| `test/` | Oracle and transaction tests on `MockNetworkProvider` with a mocked Claude client |

Stack: CashScript 0.14, libauth, Vite + React, WizardConnect, Anthropic SDK (`claude-opus-5-5`), Electrum (Fulcrum).
