import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

const cesiumBuild = "../../node_modules/.pnpm/node_modules/cesium/Build/Cesium";

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    tailwindcss(),
    viteStaticCopy({
      targets: ["Workers", "ThirdParty", "Assets", "Widgets"].map((d) => ({ src: `${cesiumBuild}/${d}`, dest: "cesium", rename: { stripBase: 6 } })),
    }),
  ],
  define: { CESIUM_BASE_URL: JSON.stringify("./cesium/") },
  server: { port: 5173, host: true },
  build: { chunkSizeWarningLimit: 6000 },
});
