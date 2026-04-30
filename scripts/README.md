# Scripts

Use these entry points:

- `license-tools.cmd`
  Windows interactive menu for status, keypair creation, customer license generation, and build.
- `license-console.mjs`
  Console command runner if you prefer typed commands.
- `publish-update-release.mjs`
  Upload a built Windows/macOS release into the hosted update admin service and register it.
- `release-manifest.mjs`
  Generate `artifacts/release/release-readiness-manifest.json` from package metadata, git state, smoke manifests, benchmark summaries, support matrix coverage, release artifacts, and key commands.
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
- Run `npm run release:manifest` after packaging and smoke checks to snapshot release readiness before tagging or manual publish.
- Use `npm run update:publish -- ...` after CI or local release builds to register a hosted update with `admin.keptra.z2hs.au`.
- The hosted update-admin image is published to `ghcr.io/zzm6899/photo-importer-update-admin:latest` by `.github/workflows/publish-update-admin-image.yml`.
