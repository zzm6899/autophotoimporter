# Scripts

Use these entry points:

- `license-tools.cmd`
  Opens the Windows menu to check status, create signing keys, generate customer licenses or build the app.
- `license-console.mjs`
  Runs the license tools from the command line.
- `publish-update-release.mjs`
  Uploads and registers a Windows or macOS build with the hosted update service.
- `release-manifest.mjs`
  Generate `artifacts/release/release-readiness-manifest.json` from package metadata, git state, smoke manifests, benchmark summaries, support matrix coverage, release artifacts, and key commands.
- `setup-windows.cmd`
  Installs dependencies and starts the app in development mode or builds it.

Typical license flow:

1. Run `scripts\license-tools.cmd`
2. Choose `Create signing keypair` once
3. Build the app
4. Generate customer licenses whenever needed

Important:

- Keep `scripts\license-keys\private.pem` secret.
- As long as you keep the same `private.pem`, new customer licenses will work with your existing EXE.
- If you replace the keypair, build and ship a new EXE.
- Run `npm run release:manifest` after packaging and smoke checks to snapshot release readiness before tagging or manual publish.
- Use `npm run update:publish -- ...` after CI or local release builds to register a hosted update with `admin.keptra.z2hs.au`.
- The hosted update-admin image is published to `ghcr.io/zzm6899/photo-importer-update-admin:latest` by `.github/workflows/publish-update-admin-image.yml`.
