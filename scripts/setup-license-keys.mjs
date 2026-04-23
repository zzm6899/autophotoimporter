import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const keyDir = path.join(root, 'scripts', 'license-keys');
const privateKeyPath = path.join(keyDir, 'private.pem');
const publicKeyPath = path.join(keyDir, 'public.pem');
const publicKeyTsPath = path.join(root, 'src', 'shared', 'license-public-key.ts');
const force = process.argv.includes('--force');

if (!existsSync(keyDir)) mkdirSync(keyDir, { recursive: true });

if ((existsSync(privateKeyPath) || existsSync(publicKeyPath)) && !force) {
  console.error('License keys already exist. Re-run with --force to replace them.');
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

writeFileSync(privateKeyPath, privatePem, { mode: 0o600 });
writeFileSync(publicKeyPath, publicPem);

const escapedPublicKey = String(readFileSync(publicKeyPath, 'utf8')).replace(/`/g, '\\`');
writeFileSync(
  publicKeyTsPath,
  `export const LICENSE_PUBLIC_KEY_PEM = \`${escapedPublicKey}\`;\n`,
);

console.log(`Created:\n- ${privateKeyPath}\n- ${publicKeyPath}\n- ${publicKeyTsPath}`);
console.log('Keep private.pem secret. Use it with npm run license:generate.');
