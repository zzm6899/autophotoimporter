import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const privateKeyPath = path.join(root, 'scripts', 'license-keys', 'private.pem');
const publicKeyPath = path.join(root, 'scripts', 'license-keys', 'public.pem');

function usage() {
  console.log(`
Photo Importer license/build console

Commands:
  keypair [--force]
      Create the signing keypair and update src/shared/license-public-key.ts

  create --name "Customer" [--email "x@y.com"] [--expiry DD-MM-YYYY] [--tier "Full access"] [--max-devices 1] [--notes "invoice 123"]
      Generate a customer license key

  build
      Build the Windows app with the current embedded public key

  status
      Show whether a signing keypair exists and explain EXE/license compatibility

Examples:
  node scripts/license-console.mjs keypair
  node scripts/license-console.mjs create --name "Jane" --expiry 31-12-2027 --tier "Full access" --max-devices 3
  node scripts/license-console.mjs build
`.trim());
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function status() {
  const hasPrivate = existsSync(privateKeyPath);
  const hasPublic = existsSync(publicKeyPath);
  console.log(`Private key: ${hasPrivate ? privateKeyPath : 'missing'}`);
  console.log(`Public key:  ${hasPublic ? publicKeyPath : 'missing'}`);
  if (hasPublic) {
    const publicKey = readFileSync(publicKeyPath, 'utf8').trim();
    console.log('\nCurrent embedded public key should match this file before you build the EXE.');
    console.log(publicKey);
  }
  console.log(`
Compatibility rule:
- If you keep using the same private.pem, you can keep generating new customer licenses and your existing EXE will accept them.
- If you regenerate/replace the keypair and then build again, old EXEs will NOT accept licenses signed by the new private key.
- Rotate the keypair only when you intend to ship a new app build with the new public key.
`.trim());
}

const [, , command, ...rest] = process.argv;

switch (command) {
  case 'keypair':
    run('node', ['scripts/setup-license-keys.mjs', ...rest]);
    break;
  case 'create':
    run('node', ['scripts/generate-license.mjs', ...rest]);
    break;
  case 'build':
    run('npm', ['run', 'make']);
    break;
  case 'status':
    status();
    break;
  case undefined:
  case 'help':
  case '--help':
  case '-h':
    usage();
    break;
  default:
    console.error(`Unknown command: ${command}\n`);
    usage();
    process.exit(1);
}
