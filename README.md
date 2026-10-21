# Pact: bet on yourself

**Stake BCH on your own goal. An AI checks your proof and signs a verdict. A covenant pays.**

You lock a little BCH in a Bitcoin Cash covenant and name a beneficiary (a friend or a charity). Before the deadline you upload a photo as proof. Claude looks at it and signs one byte: *met* or *missed*. The covenant pays the stake back to you on *met*, or to your beneficiary on *missed*. It can't pay anyone else.

## 30-second demo

1. Open the site and **Connect wallet** (WizardConnect; scan with Cashonize or Paytaca).
2. Type a goal ("I will run 5 km before Sunday"), pick a deadline, a $1 stake and a beneficiary address. Press **Stake** and approve once in the wallet.
3. On the pact page, either:
   - upload a photo (Claude judges it), or
   - press **Use sample proof (demo)**, which always passes, or
   - press **Give up**, which always fails.
4. The verdict stamp appears with Claude's reason and the oracle key that signed it. The payout transaction is broadcast automatically. Click the explorer link.

Every pact page is a share link: all the parameters live in the URL hash, so there's no database.

## How the covenant bounds the AI

`contracts/Pact.cash` (CashScript 0.14, 192 bytes) has two spending paths (simplified here):

```solidity
function settle(datasig verdictSig, bytes1 verdict) {
    // oracle signed THIS coin's outpoint + verdict, so no replay on another pact
    require(checkDataSig(verdictSig, outpointTxHash + outpointIndex + verdict, oraclePk));
    bytes20 payee = verdict == 0x01 ? ownerPkh : beneficiaryPkh;   // 0x00 or 0x01 only
    require(tx.inputs.length == 1 && tx.outputs.length == 1);
    require(tx.outputs[0].lockingBytecode == new LockingBytecodeP2PKH(payee));
    require(tx.outputs[0].value == tx.inputs[this.activeInputIndex].value - fee);
}
function expire() {   // no oracle needed: after the deadline anyone can pay the beneficiary
    require(tx.time >= deadline); /* same single-output check, to beneficiaryPkh */
}
```

- The oracle never holds funds. Its only power is to pick between two outputs fixed when the pact was funded.
- `settle` needs no user signature: anyone holding the oracle's signature can broadcast the payout, so the app does it for you.
- The settle fee is fixed (1000 sats), so nobody can skim the stake through miner fees.

## Threat model

| Risk | What happens |
|---|---|
| Owner fakes a proof photo | They only get their own money back. A cheater only cheats themselves. |
| Prompt injection in the photo or goal text | The system prompt treats both as untrusted data and defaults to *missed* when unsure. Even a fully fooled AI can only pick *met* or *missed*. Tested in `test/oracle.test.mjs`. |
| AI judges wrongly | Worst case is a wrong verdict between the two named parties, never theft. |
| Oracle goes offline or loses its key | `expire` pays the beneficiary after the deadline with no oracle. Funds are never stuck. |
| Oracle key is stolen | The thief can only pick met or missed on existing pacts. Upgrade path: a multisig oracle (several judges, 2-of-3). |
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
| `src/pact.js` | Funding, settle and expire transactions, WizardConnect sign request, share links |
| `src/wallet.js`, `src/App.jsx` | WizardConnect wallet adapter and the three screens |
| `test/` | Oracle and transaction tests on `MockNetworkProvider` with a mocked Claude client |

Stack: CashScript 0.14, libauth, Vite + React, WizardConnect, Anthropic SDK (`claude-sonnet-5-5`), Electrum (Fulcrum).
