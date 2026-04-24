# Scripts

Use these entry points:

- `license-tools.cmd`
  Windows interactive menu for status, keypair creation, customer license generation, and build.
- `license-console.mjs`
  Console command runner if you prefer typed commands.
- `publish-update-release.mjs`
  Push a built Windows/macOS release into the hosted TrueNAS update admin service.
- `release-windows.ps1`
  Build the Windows installer, upload artifacts to the TrueNAS repo at `172.20.20.251`, and register the hosted release.
- `release-windows.cmd`
  Simple Windows wrapper for the PowerShell release script.
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
- Use `npm run update:publish -- ...` after CI or local release builds to register a hosted update with `admin.culler.z2hs.au`.
- The hosted update-admin image is published to `ghcr.io/zzm6899/photo-importer-update-admin:latest` by `.github/workflows/publish-update-admin-image.yml`.

Typical hosted Windows release:

```powershell
$env:UPDATE_ADMIN_API_TOKEN="your-admin-api-token"
npm run release:windows -- -Version 1.1.1 -ServerUser root -ServerHost 172.20.20.251
```
