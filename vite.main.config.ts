import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        // onnxruntime-node is a native addon unpacked outside the asar.
        // It must NOT be bundled by Vite — it needs to be required at runtime
        // from the unpacked node_modules path so Node can find the .node binary.
        'onnxruntime-node',
      ],
    },
  },
});
