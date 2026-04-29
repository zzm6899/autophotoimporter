import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const docsToCheck = ['README.md', 'GPU_IMPLEMENTATION.md', 'deploy/truenas/README.md'];
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const npmScripts = new Set(Object.keys(packageJson.scripts || {}));
const optionalPaths = new Set(['scripts/license-keys/private.pem']);
const failures = [];

for (const docPath of docsToCheck) {
  const fullPath = path.join(root, docPath);
  const text = fs.readFileSync(fullPath, 'utf8');
  const docDir = path.dirname(fullPath);

  const existsFromDoc = (p) => {
    const normalized = p.replace(/\\/g, '/');
    const rootCandidate = path.resolve(root, normalized);
    const docCandidate = path.resolve(docDir, normalized);
    return fs.existsSync(rootCandidate) || fs.existsSync(docCandidate);
  };

  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].trim();
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    if (/^\/[A-Za-z]:\//.test(target)) continue;
    const cleaned = target.replace(/^\.\//, '').split('#')[0];
    if (!cleaned) continue;
    if (!existsFromDoc(cleaned)) failures.push(`${docPath}: missing linked path '${target}'`);
  }

  for (const match of text.matchAll(/`(scripts[\\/][^`\s]+)`/g)) {
    const scriptPath = match[1].replace(/\\/g, '/');
    if (optionalPaths.has(scriptPath)) continue;
    if (!fs.existsSync(path.resolve(root, scriptPath))) failures.push(`${docPath}: missing script path '${scriptPath}'`);
  }

  for (const match of text.matchAll(/`npm run\s+([^`\s]+)`/g)) {
    const scriptName = match[1].trim();
    if (!npmScripts.has(scriptName)) failures.push(`${docPath}: unknown npm script '${scriptName}'`);
  }
}

if (failures.length) {
  console.error('Documentation checks failed:');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log('Documentation checks passed.');
