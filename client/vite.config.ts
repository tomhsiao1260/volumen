import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    target: "esnext",
    outDir: "../build/client/page",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      // The viewer package, used from source.
      viewer: resolve(__dirname, "../viewer/src/index.ts"),
    },
  },
  worker: {
    format: "es",
  },
  server: {
    port: 3000,
    fs: {
      // The viewer package lies outside this folder.
      allow: [".."],
    },
  },
});
