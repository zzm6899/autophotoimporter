# Smoke Fixtures

Benchmarks and tests use these small files.

Regenerate them with:

```sh
npm run fixtures:smoke
```

The small files let CI check filesystem behavior, file extensions, benchmark output and how the app handles valid and corrupt images without large assets.
Add real camera RAW or HEIC fixtures only if the license allows it and the files are small enough.
