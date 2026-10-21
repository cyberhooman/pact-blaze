// Vercel Node function.
// GET  /api/judge -> {oraclePubkey, photo}  (the app bakes this key into each new pact)
// POST /api/judge -> {verdict, reason, sig, oraclePubkey}
import Anthropic from '@anthropic-ai/sdk';
import { judge, oraclePubkey } from '../lib/oracle.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const privHex = process.env.ORACLE_PRIVKEY_HEX;
  if (req.method === 'GET') {
    if (!privHex) return res.status(500).json({ error: 'Oracle key is not configured (ORACLE_PRIVKEY_HEX).' });
    return res.status(200).json({ oraclePubkey: oraclePubkey(privHex), photo: Boolean(process.env.ANTHROPIC_API_KEY) });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only.' });
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Body must be JSON.' }); } }
    const { status, body: out } = await judge(body, {
      privHex,
      client: process.env.ANTHROPIC_API_KEY ? new Anthropic() : null,
      allowSample: process.env.DISABLE_SAMPLE !== '1',
    });
    res.status(status).json(out);
  } catch (e) {
    if (e instanceof Anthropic.APIError) return res.status(502).json({ error: `AI judge unavailable (${e.status}). Try again or use Give up.` });
    res.status(500).json({ error: 'Oracle error.' });
  }
}
