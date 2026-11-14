// Vercel Node function.
// GET  /api/judge -> {oraclePubkey, photo, sampleCap}  (the app bakes this key into each new pact)
// POST /api/judge -> {verdict, reason, sig, oraclePubkey}  (sig is null unless verdict is "met")
import Anthropic from '@anthropic-ai/sdk';
import { chainProvider } from '../src/pact.js';
import { judge, oraclePubkey } from '../lib/oracle.js';

const mainnet = process.env.VITE_NETWORK === 'mainnet';
const provider = chainProvider(mainnet ? 'mainnet' : 'chipnet');
// Mainnet: sample proof only for tiny demo pacts, about $0.50 of BCH or 1.00 PUSD (100 units, 2 decimals).
const sampleCap = mainnet
  ? { sats: BigInt(process.env.SAMPLE_MAX_SATS || Math.round(0.5 / Number(process.env.VITE_BCH_USD || 400) * 1e8)), units: 100n }
  : null;

export default async function handler(req, res) {
  const privHex = process.env.ORACLE_PRIVKEY_HEX;
  if (req.method === 'GET') {
    if (!privHex) return res.status(500).json({ error: 'Oracle key is not configured (ORACLE_PRIVKEY_HEX).' });
    return res.status(200).json({ oraclePubkey: oraclePubkey(privHex), photo: Boolean(process.env.ANTHROPIC_API_KEY),
      sampleCap: sampleCap && { sats: String(sampleCap.sats), units: String(sampleCap.units) } });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only.' });
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Body must be JSON.' }); } }
    const { status, body: out } = await judge(body, {
      privHex,
      provider,
      client: process.env.ANTHROPIC_API_KEY ? new Anthropic() : null,
      allowSample: process.env.DISABLE_SAMPLE !== '1',
      sampleCap,
    });
    res.status(status).json(out);
  } catch (e) {
    if (e instanceof Anthropic.APIError) return res.status(502).json({ error: `AI judge unavailable (${e.status}). Try again before the deadline.` });
    res.status(500).json({ error: 'Oracle error.' });
  }
}
