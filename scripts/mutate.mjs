// Mutation test: delete each require() in Pact.cash in turn; the contract tests must fail every time.
// Run: npm run mutate
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const file = new URL('../contracts/Pact.cash', import.meta.url);
const src = readFileSync(file, 'utf8');
const lines = src.split('\n');
const targets = lines.flatMap((l, i) => (l.trim().startsWith('require(') ? [i] : []));
const survived = [];
try {
  for (const i of targets) {
    writeFileSync(file, lines.map((l, j) => (j === i ? `// MUTANT ${l}` : l)).join('\n'));
    if (spawnSync(process.execPath, ['contracts/test.mjs'], { stdio: 'ignore' }).status === 0) survived.push(`line ${i + 1}: ${lines[i].trim()}`);
  }
} finally {
  writeFileSync(file, src);
}
console.log(`mutants ${targets.length}, killed ${targets.length - survived.length}`);
if (survived.length) { console.log('SURVIVED:\n ' + survived.join('\n ')); process.exit(1); }
