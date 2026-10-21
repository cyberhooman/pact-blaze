// One-time local setup. Run: npm run setup
// - creates .env from .env.example if missing
// - creates the oracle signing key if missing (never overwrites it: every pact is bound to it)
// - asks for your Anthropic API key with hidden input and saves it; the key is never printed
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { generatePrivateKey, binToHex } from '@bitauth/libauth';
import { oraclePubkey } from '../lib/oracle.js';

const envPath = process.argv[2] ?? new URL('../.env', import.meta.url);
const KEY_RE = /sk-ant-api\d\d-[A-Za-z0-9_-]{20,}/;

const getEnv = (text, key) => text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1].trim() ?? '';
const setEnv = (text, key, value) => (new RegExp(`^${key}=.*$`, 'm').test(text)
  ? text.replace(new RegExp(`^${key}=.*$`, 'm'), () => `${key}=${value}`)
  : `${text.replace(/\n?$/, '\n')}${key}=${value}\n`);

// Read one line without echoing it (paste works: right-click or Ctrl+V in the terminal).
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

let env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : readFileSync(new URL('../.env.example', import.meta.url), 'utf8');

if (!getEnv(env, 'ORACLE_PRIVKEY_HEX')) {
  const priv = binToHex(generatePrivateKey());
  env = setEnv(env, 'ORACLE_PRIVKEY_HEX', priv);
  console.log(`Oracle key created. Public key: ${oraclePubkey(priv)}`);
  console.log('Back up .env somewhere safe: pacts made with this key need it forever.');
} else {
  console.log(`Oracle key already set (public key ${oraclePubkey(getEnv(env, 'ORACLE_PRIVKEY_HEX'))}), left unchanged.`);
}

const current = getEnv(env, 'ANTHROPIC_API_KEY');
const pasted = await askHidden(`Paste your Anthropic API key${current ? ' (Enter keeps the saved one)' : ' (Enter to skip)'}: `);
const key = pasted.match(KEY_RE)?.[0];
if (!pasted) {
  console.log(current ? 'Kept the saved Anthropic key.' : 'Skipped. Photo judging stays off; sample proof and Give up still work.');
} else if (!key) {
  console.log(`That doesn't look like a Console API key (they start with "sk-ant-api03-"). Nothing saved.`);
  console.log('Create one at console.anthropic.com > Settings > API Keys.');
} else {
  env = setEnv(env, 'ANTHROPIC_API_KEY', key);
  console.log(`Anthropic key saved (ends in ...${key.slice(-4)}).`);
}

writeFileSync(envPath, env);
console.log(`Wrote ${envPath instanceof URL ? '.env' : envPath}. It is gitignored, so it is never committed.`);
