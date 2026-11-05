import { defineConfig } from "vite";

// The server and the tiler's worker thread are built side by side: dist/main.js starts
// dist/tiler-worker.js (WP 3.4).
export default defineConfig({
  build: {
    ssr: true,
    rollupOptions: {
      input: { main: "src/main.ts", "tiler-worker": "src/tiler-worker.ts" },
      // Chunks beside the entries: the tiler finds its worker next to itself.
      output: { entryFileNames: "[name].js", chunkFileNames: "[name]-[hash].js" },
    },
  },
});
