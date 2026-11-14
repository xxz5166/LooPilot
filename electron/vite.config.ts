import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "electron/renderer",
  plugins: [react()],
  build: {
    outDir: "../renderer-dist",
    emptyOutDir: true
  },
  server: {
    port: 5174,
    strictPort: true
  }
});
