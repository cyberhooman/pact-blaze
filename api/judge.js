// Vercel Node function: POST /api/judge -> {verdict, reason, sig, oraclePubkey}
import Anthropic from '@anthropic-ai/sdk';
import { judge } from '../lib/oracle.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { status, body: out } = await judge(body, {
      privHex: process.env.ORACLE_PRIVKEY_HEX,
      client: process.env.ANTHROPIC_API_KEY ? new Anthropic() : null,
      allowSample: process.env.DISABLE_SAMPLE !== '1',
    });
    res.status(status).json(out);
  } catch (e) {
    if (e instanceof Anthropic.APIError) return res.status(502).json({ error: `AI judge unavailable (${e.status}). Try again or use Give up.` });
    res.status(500).json({ error: 'Oracle error.' });
  }
}
