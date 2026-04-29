# Release Checklist

Use this checklist before tagging or manually publishing a release.

1. Sync docs and support matrix:
   `npm run docs:sync-matrix`

2. Run the verification gate:
   `npm run verify`

3. Build release artifacts:
   `npm run make`

4. Smoke the packaged app and fixtures:
   `npm run package:smoke`
   `npm run fixtures:smoke`
   `npm run bench:smoke`

5. Generate the release readiness manifest:
   `npm run release:manifest`

The manifest is written to `artifacts/release/release-readiness-manifest.json` and captures package metadata, git commit state, packaged smoke manifests, benchmark summaries, support matrix coverage, generated artifacts, and the key release commands.

Before publishing, confirm the manifest shows the expected version, commit, package smoke output, benchmark summary count, support platforms, and release artifact paths.
