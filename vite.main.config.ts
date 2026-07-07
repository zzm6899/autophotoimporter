import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        // onnxruntime-node is a native addon unpacked outside the asar.
        // It must NOT be bundled by Vite — it needs to be required at runtime
        // from the unpacked node_modules path so Node can find the .node binary.
        'onnxruntime-node',
        // sharp is a native addon (libvips). It must stay a runtime require so
        // the auto-unpack-natives plugin can serve its .node binaries from
        // app.asar.unpacked. exif-parser loads it lazily with a try/catch
        // fallback, so a missing/foreign-arch binary degrades gracefully to
        // the sips/PowerShell/ImageMagick paths.
        'sharp',
      ],
    },
  },
});
