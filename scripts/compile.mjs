// Compile contracts/Pact.cash to src/Pact.json so the browser needs no compiler. Run: npm run compile
import { compileFile } from 'cashc';
import { writeFileSync } from 'node:fs';

const artifact = compileFile(new URL('../contracts/Pact.cash', import.meta.url));
delete artifact.updatedAt;
writeFileSync(new URL('../src/Pact.json', import.meta.url), JSON.stringify(artifact, null, 2) + '\n');
console.log(`src/Pact.json: ${artifact.contractName}, ${artifact.abi.length} functions`);
