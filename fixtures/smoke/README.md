# Smoke Fixtures

Tiny checked-in files used by benchmark and fixture-backed test scaffolding.

Regenerate them with:

```sh
npm run fixtures:smoke
```

These are intentionally minimal files so CI can verify filesystem,
extension mix, benchmark output, image handling, and corrupt-file handling without large assets.
Real camera RAW/HEIC fixtures should be added only when licensing and size are acceptable.
