# Scripts

Use these entry points:

- `license-tools.cmd`
  Windows interactive menu for status, keypair creation, customer license generation, and build.
- `license-console.mjs`
  Console command runner if you prefer typed commands.
- `setup-windows.cmd`
  Dependency install and dev/build helper.

Typical license flow:

1. Run `scripts\license-tools.cmd`
2. Choose `Create signing keypair` once
3. Build the app
4. Generate customer licenses whenever needed

Important:

- Keep `scripts\license-keys\private.pem` secret.
- As long as you keep the same `private.pem`, new customer licenses will work with your existing EXE.
- If you replace the keypair, build and ship a new EXE.
