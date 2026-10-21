import { useEffect, useMemo, useState } from 'react';
import { useWizardConnect, WizardConnectQRDialog } from '@wizardconnect/react';
import { chainProvider, makePact, buildFunding, fundingSignRequest, buildRelease, buildForfeit, forfeitSignRequest, buildExpire, platformFee, pkhAddress, encodeShare, decodeShare, SETTLE_FEE } from './pact.js';
import { ownerOf, walletUtxos, signAndSend, parseP2pkh } from './wallet.js';
import { NETWORK, FEE_ADDRESS, BANNER, BENEFICIARIES, FALLBACK_BCH_USD, explorerTx, explorerAddress } from './config.js';

const provider = chainProvider(NETWORK);
const short = (s, n = 6) => (s && s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);
const fmtSats = (s) => Number(s).toLocaleString('en-US');
const fmtUsd = (sats, usd) => `$${((Number(sats) / 1e8) * usd).toFixed(2)}`;

// Small per-browser memory of verdicts and payout txids; the chain is the source of truth.
const remember = (txid, v) => { try { localStorage.setItem(`pact:${txid}`, JSON.stringify(v)); } catch {} };
const recall = (txid) => { try { return JSON.parse(localStorage.getItem(`pact:${txid}`)); } catch { return null; } };

function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => { const on = () => setHash(location.hash); addEventListener('hashchange', on); return () => removeEventListener('hashchange', on); }, []);
  return hash;
}

function useBchUsd() {
  const [usd, setUsd] = useState(FALLBACK_BCH_USD);
  useEffect(() => {
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=usd')
      .then((r) => r.json()).then((j) => j['bitcoin-cash']?.usd && setUsd(j['bitcoin-cash'].usd)).catch(() => {});
  }, []);
  return usd;
}

function useNow() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => { const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(t); }, []);
  return now;
}

export default function App() {
  const hash = useHash();
  const usd = useBchUsd();
  const [why, setWhy] = useState(false);
  const wc = useWizardConnect({ dappName: 'Pact', dappIcon: `${location.origin}/favicon.svg` });
  const share = hash.startsWith('#/p/') ? hash.slice(4) : null;

  return (
    <>
      <Banner />
      <header className="top">
        <a href="#/" className="logo"><span className="seal">P</span>Pact</a>
        <button className="link" onClick={() => setWhy(true)}>Why the AI can't steal</button>
      </header>
      <main>
        {share ? <PactPage key={share} share={share} usd={usd} wc={wc} /> : <Create wc={wc} usd={usd} />}
      </main>
      <footer>
        Pact runs on Bitcoin Cash {NETWORK}. Wallets: Cashonize, Paytaca (via WizardConnect).
      </footer>
      {why && <WhyModal onClose={() => setWhy(false)} />}
      {wc.uri && wc.qrUri && (
        <WizardConnectQRDialog show={wc.state === 'connecting'} onClose={wc.disconnect} uri={wc.uri} qrUri={wc.qrUri}
          subtitle="Scan with Cashonize or Paytaca"
          theme={{ dialogBackground: '#f6f1e7', headerBackground: '#f6f1e7', titleColor: '#17130e', subtitleColor: '#5b5146', borderColor: '#d8cdbb', uriRowBackground: '#ece4d4', uriTextColor: '#5b5146', closeButtonColor: '#17130e', copyButtonColor: '#17130e' }} />
      )}
    </>
  );
}

function Banner() {
  return (
    <div className="banner">
      <span className="tag">BCH BLAZE 2026</span>
      <a href={BANNER.slides} target="_blank" rel="noreferrer">Slides</a>
      <a href={BANNER.repo} target="_blank" rel="noreferrer">GitHub</a>
      <button className="vote" title="Copy the EMBER2026 vote address" onClick={() => navigator.clipboard?.writeText(BANNER.vote)}>
        Vote EMBER2026: <code>{short(BANNER.vote, 10)}</code>
      </button>
    </div>
  );
}

function Create({ wc, usd }) {
  const defaultDeadline = useMemo(() => {
    const d = new Date(Date.now() + 7 * 864e5); d.setMinutes(0, 0, 0);
    return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  }, []);
  const [goal, setGoal] = useState('');
  const [deadline, setDeadline] = useState(defaultDeadline);
  const [stakeUsd, setStakeUsd] = useState(1);
  const [benef, setBenef] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [oracle, setOracle] = useState(null);

  useEffect(() => { fetch('/api/judge').then((r) => r.json()).then(setOracle).catch(() => setOracle({ error: 'Oracle unreachable.' })); }, []);

  const stake = BigInt(Math.max(10_000, Math.round((stakeUsd / usd) * 1e8)));
  const fee = platformFee(stake);
  const connected = wc.state === 'connected' && wc.manager;
  const fullGoal = `I will ${goal.trim()}`;

  async function stakeIt() {
    setErr('');
    try {
      if (!goal.trim()) throw new Error('Write your goal first.');
      if (new TextEncoder().encode(fullGoal).length > 120) throw new Error('Keep the goal under 120 bytes.');
      const dl = Math.floor(new Date(deadline).getTime() / 1000);
      if (!(dl > Date.now() / 1000 + 600)) throw new Error('Pick a deadline at least 10 minutes away.');
      const beneficiaryPkh = parseP2pkh(benef, NETWORK);
      if (!oracle?.oraclePubkey) throw new Error(oracle?.error || 'Oracle not ready yet.');
      if (!FEE_ADDRESS) throw new Error('VITE_FEE_ADDRESS is not set for this deployment.');
      const owner = ownerOf(wc.manager, NETWORK);
      if (owner.pkh === beneficiaryPkh) throw new Error('The beneficiary must be someone else.');
      const params = { ownerPkh: owner.pkh, beneficiaryPkh, oraclePk: oracle.oraclePubkey, deadline: dl, fee: SETTLE_FEE };
      const contract = makePact(params, provider);

      setBusy('Finding your coins…');
      const utxos = await walletUtxos(wc.manager, provider, NETWORK);
      const funding = buildFunding({ utxos, contract, stake, goal: fullGoal, deadline: dl, feeAddress: FEE_ADDRESS, changeAddress: owner.address, provider });
      setBusy('Approve in your wallet…');
      const txid = await signAndSend(wc.manager, provider, fundingSignRequest(funding, `Pact: ${fullGoal}`));
      location.hash = `#/p/${encodeShare({ ...params, network: NETWORK, goal: fullGoal, stake, txid, vout: 0 })}`;
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="create">
      <h1>Bet on yourself.<br /><em>An AI judges.</em><br />The covenant pays.</h1>
      <p className="lede">Stake a little BCH on a goal. Prove it with a photo before the deadline and it comes back to you. Miss it and it goes to the person or charity you named. Nobody else can ever touch it.</p>

      <div className="card form">
        <label className="goal">
          <span>I will</span>
          <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="run 5 km before Sunday" maxLength={110} />
        </label>

        <div className="row">
          <label>
            <span className="lbl">Deadline</span>
            <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </label>
          <label>
            <span className="lbl">Stake</span>
            <div className="chips">
              {[0.5, 1, 2].map((v) => (
                <button key={v} type="button" className={stakeUsd === v ? 'chip on' : 'chip'} onClick={() => setStakeUsd(v)}>${v.toFixed(2)}</button>
              ))}
            </div>
            <small>{fmtSats(stake)} sats + 1% fee ({fmtSats(fee)} sats)</small>
          </label>
        </div>

        <label>
          <span className="lbl">If I miss it, the stake goes to</span>
          <div className="chips">
            {BENEFICIARIES.map((b) => (
              <button key={b.label} type="button" disabled={!b.address} title={b.address || 'Set VITE_BENEFICIARIES'}
                className={benef === b.address && b.address ? 'chip on' : 'chip'} onClick={() => setBenef(b.address)}>{b.label}</button>
            ))}
          </div>
          <input className="mono" value={benef} onChange={(e) => setBenef(e.target.value)} placeholder={NETWORK === 'mainnet' ? 'bitcoincash:q…' : 'bchtest:q…'} />
        </label>

        {connected ? (
          <button className="primary" disabled={!!busy} onClick={stakeIt}>
            {busy || `Stake ${fmtUsd(stake, usd)} on it`}
          </button>
        ) : (
          <button className="primary" disabled={wc.state === 'connecting' && !wc.uri} onClick={wc.connect}>
            {wc.state === 'connecting' && !wc.uri ? 'Opening WizardConnect…' : 'Connect wallet'}
          </button>
        )}
        {connected && <p className="muted">Connected to {wc.walletName || 'wallet'} · <button className="link" onClick={wc.disconnect}>disconnect</button></p>}
        {(err || wc.error) && <p className="error">{err || wc.error}</p>}
      </div>

      <ol className="steps">
        <li><span><b>Stake.</b> One wallet approval locks your BCH in a covenant.</span></li>
        <li><span><b>Prove it.</b> Upload a photo. Claude looks at it and signs a verdict.</span></li>
        <li><span><b>Get paid.</b> The covenant releases the stake to you, or to your beneficiary.</span></li>
      </ol>
    </section>
  );
}

async function resizeToJpeg(file, max = 1280) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85).split(',')[1];
}

function PactPage({ share, usd, wc }) {
  const p = useMemo(() => { try { return decodeShare(share); } catch (e) { return { error: e.message }; } }, [share]);
  const contract = useMemo(() => (p.error ? null : makePact(p, provider)), [p]);
  const now = useNow();
  const [utxo, setUtxo] = useState(undefined); // undefined = loading, null = not on chain
  const [result, setResult] = useState(() => (p.txid ? recall(p.txid) : null));
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [seen, setSeen] = useState(false); // the stake has been seen at the covenant at least once

  useEffect(() => { if (utxo) setSeen(true); }, [utxo]);
  useEffect(() => {
    if (!contract) return;
    let live = true;
    const load = () => contract.getUtxos()
      .then((us) => live && setUtxo(us.find((u) => u.txid === p.txid && u.vout === p.vout) ?? null))
      .catch(() => live && setErr('Could not reach the Bitcoin Cash network. Retrying…'));
    load();
    const t = setInterval(load, 15000);
    return () => { live = false; clearInterval(t); };
  }, [contract]);

  if (p.error) return <p className="error">{p.error}</p>;

  const left = p.deadline - now;
  const settled = Boolean(result?.payoutTxid || (utxo === null && seen));
  const owner = pkhAddress(p.ownerPkh, p.network), beneficiary = pkhAddress(p.beneficiaryPkh, p.network);

  const save = (r) => { setResult(r); remember(p.txid, r); };

  async function run(mode, image) {
    setErr('');
    try {
      setBusy(mode === 'photo' ? 'Claude is looking at your photo…' : 'Asking the oracle…');
      const r = await fetch('/api/judge', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txid: p.txid, vout: p.vout, goal: p.goal, deadline: p.deadline, mode, image,
          ownerPkh: p.ownerPkh, beneficiaryPkh: p.beneficiaryPkh, fee: String(p.fee) }) });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error || `Oracle error ${r.status}`);
      if (v.oraclePubkey !== p.oraclePk) throw new Error('This oracle key does not match the one in the pact.');
      // A missed photo is unsigned: nothing to broadcast, the owner can try another photo.
      if (!v.sig) return setResult({ ...v, mode });
      save({ ...v, mode });
      await release(v.sig, { ...v, mode });
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy('');
    }
  }

  // Goal met: broadcast the oracle-signed release. It can only pay the owner.
  async function release(sig, verdict) {
    setBusy('Broadcasting the payout…');
    const tx = await buildRelease({ contract, utxo, sig, ownerPkh: p.ownerPkh, network: p.network, provider, fee: p.fee }).send();
    save({ ...verdict, payoutTxid: tx.txid });
  }

  // Give up: the owner's own wallet signs the stake over to the beneficiary.
  async function giveUp() {
    setErr('');
    if (!(wc.state === 'connected' && wc.manager)) {
      setErr("Connect the owner's wallet, then press Give up again.");
      return wc.connect();
    }
    if (!confirm('Give up? The stake goes to your beneficiary.')) return;
    try {
      if (ownerOf(wc.manager, p.network).pkh !== p.ownerPkh) throw new Error('This wallet is not the owner of this pact. Connect the wallet that staked it.');
      const forfeit = buildForfeit({ contract, utxo, beneficiaryPkh: p.beneficiaryPkh, network: p.network, provider, fee: p.fee });
      setBusy('Approve in your wallet…');
      const payoutTxid = await signAndSend(wc.manager, provider, forfeitSignRequest(forfeit, `Give up: ${p.goal}`));
      save({ verdict: 'missed', reason: 'The owner gave up. Their wallet signed the stake over to the beneficiary.', payoutTxid, mode: 'forfeit' });
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy('');
    }
  }

  async function expire() {
    setErr('');
    try {
      setBusy('Broadcasting the expiry…');
      const tx = await buildExpire({ contract, utxo, beneficiaryPkh: p.beneficiaryPkh, deadline: p.deadline, network: p.network, provider, fee: p.fee }).send();
      const done = { verdict: 'missed', reason: 'Deadline passed with no verdict. The covenant released the stake to the beneficiary.', payoutTxid: tx.txid, mode: 'expire' };
      save(done);
    } catch (e) {
      setErr(`Not spendable yet: the network clock (median time) runs about an hour behind. Try again later. (${e.message})`);
    } finally {
      setBusy('');
    }
  }

  const status = settled ? 'Settled' : utxo === undefined ? 'Checking…' : left > 0 ? 'Live' : 'Expired';
  return (
    <section className="pact">
      <div className="card hero">
        <span className={`status s-${status.toLowerCase().replace('…', '')}`}>{status}</span>
        <h2>“{p.goal}”</h2>
        <div className="stats">
          <div><b>{fmtSats(p.stake)}</b><small>sats staked · {fmtUsd(p.stake, usd)}</small></div>
          <div><b className="mono">{left > 0 ? countdown(left) : '00:00:00'}</b><small>until {new Date(p.deadline * 1000).toLocaleString()}</small></div>
        </div>
        <dl className="chain">
          <dt>Met</dt><dd><a href={explorerAddress(owner)} target="_blank" rel="noreferrer">{short(owner, 10)}</a> (owner)</dd>
          <dt>Give up / deadline</dt><dd><a href={explorerAddress(beneficiary)} target="_blank" rel="noreferrer">{short(beneficiary, 10)}</a> (beneficiary)</dd>
          <dt>Stake tx</dt><dd><a href={explorerTx(p.txid)} target="_blank" rel="noreferrer">{short(p.txid, 8)}</a></dd>
          <dt>Covenant</dt><dd><a href={explorerAddress(contract.address)} target="_blank" rel="noreferrer">{short(contract.address, 10)}</a></dd>
        </dl>
        <button className="link" onClick={() => navigator.clipboard?.writeText(location.href)}>Copy share link</button>
      </div>

      {!settled && utxo && left > 0 && !result?.sig && (
        <div className="card actions">
          <h3>Prove it</h3>
          <label className={busy ? 'upload disabled' : 'upload'}>
            <input type="file" accept="image/jpeg,image/png" capture="environment" disabled={!!busy}
              onChange={async (e) => { const f = e.target.files?.[0]; if (f) run('photo', await resizeToJpeg(f)); }} />
            <span>📷 Upload a photo of your proof</span>
          </label>
          <div className="row2">
            <button className="secondary" disabled={!!busy} onClick={() => run('sample')}>Use sample proof (demo)</button>
            <button className="danger" disabled={!!busy} onClick={giveUp}>Give up</button>
          </div>
          <p className="muted">The demo sample proof always passes, so you can try the full flow without a photo. Give up needs the owner's wallet to sign.</p>
        </div>
      )}

      {!settled && utxo && left <= 0 && !result?.sig && (
        <div className="card actions">
          <h3>Deadline passed</h3>
          <p>The oracle no longer signs. Anyone can release the stake to the beneficiary.</p>
          <button className="danger" disabled={!!busy} onClick={expire}>Release to beneficiary</button>
        </div>
      )}

      {result?.sig && !result.payoutTxid && utxo && (
        <button className="primary" disabled={!!busy} onClick={() => release(result.sig, result).catch((e) => setErr(e.message || String(e))).finally(() => setBusy(''))}>Retry payout</button>
      )}

      {busy && <p className="busy">{busy}</p>}
      {err && <p className="error">{err}</p>}

      {result && <Verdict r={result} owner={owner} beneficiary={beneficiary} />}
      {settled && !result && <p className="muted">This pact's coin is no longer at the covenant: it was settled. See the covenant address for the payout.</p>}
      {utxo === null && !seen && !result && <p className="muted">Just staked? The network can take a few seconds to show it.</p>}
    </section>
  );
}

const countdown = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d ? `${d}d ` : ''}${pad(h)}:${pad(m)}:${pad(x)}`;
};

function Verdict({ r, owner, beneficiary }) {
  const met = r.verdict === 'met';
  if (!met && !r.payoutTxid) {
    return (
      <div className="card verdict missed">
        <div className="stamp">NOT ACCEPTED</div>
        <p className="reason">{r.reason}</p>
        <p className="muted">Not accepted. Try another photo before the deadline.</p>
      </div>
    );
  }
  return (
    <div className={`card verdict ${met ? 'met' : 'missed'}`}>
      <div className="stamp">{met ? 'GOAL MET' : r.mode === 'forfeit' ? 'GAVE UP' : 'MISSED'}</div>
      <p className="reason">{r.reason}</p>
      {r.mode === 'sample' && <p className="muted">Demo sample proof: no photo was judged.</p>}
      <dl className="chain">
        {met && r.oraclePubkey && <><dt>Signed by</dt><dd className="mono">oracle {short(r.oraclePubkey, 4)}</dd></>}
        <dt>Pays</dt><dd>{met ? `owner ${short(owner, 10)}` : `beneficiary ${short(beneficiary, 10)}`}</dd>
        <dt>Payout tx</dt><dd>{r.payoutTxid ? <a href={explorerTx(r.payoutTxid)} target="_blank" rel="noreferrer">{short(r.payoutTxid, 8)} ↗</a> : 'pending…'}</dd>
      </dl>
    </div>
  );
}

const PITCH = "The AI's only power is to give your money back. Only you, or the deadline, can send it to your beneficiary.";

const CODE = `function release(datasig verdictSig) {   // the AI: goal met
  require(checkDataSig(verdictSig, outpoint + 0x01, oraclePk));
  require(tx.outputs[0].lockingBytecode == new LockingBytecodeP2PKH(ownerPkh));
}
function forfeit(pubkey ownerPk, sig ownerSig) {   // you: give up
  require(hash160(ownerPk) == ownerPkh && checkSig(ownerSig, ownerPk));
  require(tx.outputs[0].lockingBytecode == new LockingBytecodeP2PKH(beneficiaryPkh));
}
function expire() {   // the clock: deadline passed
  require(tx.time >= deadline);
  require(tx.outputs[0].lockingBytecode == new LockingBytecodeP2PKH(beneficiaryPkh));
}
// every path: 1 input, 1 output, value == stake - fee`;

function WhyModal({ onClose }) {
  useEffect(() => { const k = (e) => e.key === 'Escape' && onClose(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Why the AI can't steal" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose} aria-label="Close">×</button>
        <h2>Why the AI can't steal</h2>
        <p className="pitch"><b>{PITCH}</b></p>
        <p>The AI never holds the money. It can only sign "met" for one coin, and the covenant, fixed when you stake, lets that signature pay only the owner. These lines from <code>Pact.cash</code> (simplified) do the work:</p>
        <pre><code>{CODE}</code></pre>
        <ul>
          <li><b>A cheater only cheats themselves.</b> Fake proof just returns your own money to you.</li>
          <li><b>No one can make you lose.</b> Sending the stake to the beneficiary needs your own wallet signature, or the deadline. A rejected photo sends nothing; you can try again.</li>
          <li><b>The worst case is a wrong verdict, never theft.</b> Every path ends at the owner or the beneficiary you named.</li>
          <li><b>Funds are never stuck.</b> After the deadline, <code>expire</code> pays the beneficiary with no oracle at all.</li>
          <li><b>No replay.</b> The signature covers this exact coin, so it can't release another pact.</li>
          <li><b>Single oracle key today.</b> A multisig oracle (several judges) is the upgrade path.</li>
        </ul>
      </div>
    </div>
  );
}
