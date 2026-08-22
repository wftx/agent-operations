import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packagesRoot = join(repositoryRoot, 'packages');
const failures = [];
const importPattern = /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;
const coreInternalPattern = /(?:^|\/)src\/(?:daemon|pty|hooks)(?:\/|$)/;

function walk(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name)) files.push(path);
  }
  return files;
}

for (const packageEntry of readdirSync(packagesRoot, { withFileTypes: true })) {
  if (!packageEntry.isDirectory()) continue;
  const packageName = packageEntry.name;
  const sourceRoot = join(packagesRoot, packageName, 'src');
  for (const file of walk(sourceRoot)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (coreInternalPattern.test(specifier)) {
        failures.push(`${relative(repositoryRoot, file)} imports forbidden CortextOS core path: ${specifier}`);
      }
      const isContractOrDomain = packageName === 'agent-operations-contracts'
        || /^agent-operations-(?:core|domain)$/.test(packageName);
      if (isContractOrDomain && specifier.includes('cortextos-adapter')) {
        failures.push(`${relative(repositoryRoot, file)} makes AO contracts/domain depend on the CortextOS adapter`);
      }
    }
  }
}

if (failures.length) {
  console.error('Agent Operations boundary violations:\n' + failures.map(item => `- ${item}`).join('\n'));
  process.exit(1);
}

console.log('Agent Operations import boundary: OK');
