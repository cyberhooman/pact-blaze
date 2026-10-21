// One-time local setup. Run: npm run setup
// - creates .env from .env.example if missing
// - creates the oracle signing key if missing (never overwrites it: every pact is bound to it)
// - takes your Anthropic API key from the clipboard (or a hidden paste), asks Anthropic whether
//   it is valid, and saves it. The key is never printed.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { generatePrivateKey, binToHex } from '@bitauth/libauth';
import { oraclePubkey } from '../lib/oracle.js';

const envPath = process.argv[2] ?? new URL('../.env', import.meta.url);
const KEY_RE = /sk-ant-[A-Za-z0-9_-]{20,}/; // loose on purpose: Anthropic, not this regex, decides validity

const getEnv = (text, key) => text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1].trim() ?? '';
const setEnv = (text, key, value) => (new RegExp(`^${key}=.*$`, 'm').test(text)
  ? text.replace(new RegExp(`^${key}=.*$`, 'm'), () => `${key}=${value}`)
  : `${text.replace(/\n?$/, '\n')}${key}=${value}\n`);

const clipboard = () => {
  if (process.platform !== 'win32') return '';
  try { return execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard'], { encoding: 'utf8' }); } catch { return ''; }
};

// Read one line without echoing it.
function askHidden(question) {
  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setEncoding('utf8');
  if (!stdin.isTTY) return new Promise((done) => { let s = ''; stdin.on('data', (c) => { s += c; }); stdin.on('end', () => done(s.trim())); });
  return new Promise((done) => {
    let input = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') process.exit(1);                          // Ctrl+C
        if (ch === '\r' || ch === '\n') {
          stdin.off('data', onData); stdin.setRawMode(false); stdin.pause();
          process.stdout.write('\n');
          return done(input.trim());
        }
        input = ch === '\u007f' || ch === '\b' ? input.slice(0, -1) : input + ch;
      }
    };
    stdin.setRawMode(true); stdin.resume(); stdin.on('data', onData);
  });
}

// Ask Anthropic (free models list call). Returns 'ok' | 'rejected' | 'unknown'.
async function checkKey(apiKey) {
  try { await new Anthropic({ apiKey, maxRetries: 0 }).models.list({ limit: 1 }); return 'ok'; }
  catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return 'rejected';
    return 'unknown';
  }
}

let env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : readFileSync(new URL('../.env.example', import.meta.url), 'utf8');

if (!getEnv(env, 'ORACLE_PRIVKEY_HEX')) {
  const priv = binToHex(generatePrivateKey());
  env = setEnv(env, 'ORACLE_PRIVKEY_HEX', priv);
  console.log(`Oracle key created. Public key: ${oraclePubkey(priv)}`);
  console.log('Back up .env somewhere safe: pacts made with this key need it forever.');
} else {
  console.log(`Oracle key already set (public key ${oraclePubkey(getEnv(env, 'ORACLE_PRIVKEY_HEX'))}), left unchanged.`);
}

const pasted = await askHidden('Copy your Anthropic API key, then press Enter here (or paste it, then Enter): ');
const fromClipboard = !pasted;
const source = fromClipboard ? clipboard() : pasted;
const key = source.match(KEY_RE)?.[0];

if (!key) {
  const where = fromClipboard ? 'Your clipboard' : 'What you pasted';
  console.log(`${where} has no Anthropic key in it (${source.trim().length} characters, no "sk-ant-..."). Nothing saved.`);
  if (fromClipboard) console.log('Copy the key from console.anthropic.com > Settings > API Keys, then run npm run setup again.');
} else {
  process.stdout.write(`Found a key ending in ...${key.slice(-4)}${fromClipboard ? ' on your clipboard' : ''}. Checking it with Anthropic... `);
  const status = await checkKey(key);
  if (status === 'rejected') {
    console.log('rejected.');
    console.log('Anthropic says this key is not valid (wrong kind of token, revoked, or mistyped). Nothing saved.');
    console.log('Create a new one at console.anthropic.com > Settings > API Keys > Create Key ("Continue with an API key").');
  } else {
    console.log(status === 'ok' ? 'valid.' : 'could not reach Anthropic, saved anyway.');
    env = setEnv(env, 'ANTHROPIC_API_KEY', key);
    console.log('Anthropic key saved. If photo judging later says "unavailable", add credit under Settings > Billing.');
  }
}

writeFileSync(envPath, env);
console.log(`Wrote ${envPath instanceof URL ? '.env' : envPath}. It is gitignored, so it is never committed.`);
