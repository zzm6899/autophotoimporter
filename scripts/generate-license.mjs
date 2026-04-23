import { sign, createPrivateKey } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const defaultPrivateKeyPath = path.join(root, 'scripts', 'license-keys', 'private.pem');

function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

function normalizeDate(value) {
  if (!value) return undefined;
  if (/^\d{2}-\d{2}-\d{4}$/.test(value)) {
    const [day, month, year] = value.split('-');
    return `${year}-${month}-${day}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  throw new Error(`Invalid date "${value}". Use DD-MM-YYYY.`);
}

function displayToday() {
  const now = new Date().toISOString().slice(0, 10);
  const [year, month, day] = now.split('-');
  return `${day}-${month}-${year}`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const part = argv[i];
    if (!part.startsWith('--')) continue;
    const key = part.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = 'true';
      continue;
    }
    args[key] = next;
    i++;
  }
  return args;
}

const args = parseArgs(process.argv);
const privateKeyPath = args['private-key'] || defaultPrivateKeyPath;

if (!args.name) {
  console.error('Usage: node scripts/generate-license.mjs --name "Customer Name" [--email "x@y.com"] [--expiry 31-12-2027] [--tier pro] [--notes "invoice 123"]');
  process.exit(1);
}

if (!existsSync(privateKeyPath)) {
  console.error(`Private key not found at ${privateKeyPath}. Run npm run license:keypair first.`);
  process.exit(1);
}

let expiry;
try {
  expiry = normalizeDate(args.expiry);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid expiry date');
  process.exit(1);
}

const entitlement = {
  n: args.name,
  ...(args.email ? { e: args.email } : {}),
  i: normalizeDate(displayToday()),
  ...(expiry ? { x: expiry } : {}),
  t: args.tier || 'Full access',
  ...(args.notes ? { o: args.notes } : {}),
};

const payload = Buffer.from(JSON.stringify(entitlement), 'utf8');
const privateKey = createPrivateKey(readFileSync(privateKeyPath, 'utf8'));
const signature = sign(null, payload, privateKey);
const licenseKey = `PI1-${base64Url(payload)}.${base64Url(signature)}`;

console.log(licenseKey);
