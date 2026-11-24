import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  root: "app",
  publicDir: "public",
  build: { outDir: "../dist/client", emptyOutDir: true, sourcemap: false },
  server: {
    // `npm run dev` serves the app; run `wrangler dev` alongside for the API.
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false } },
  },
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectRegister: "script", // a file, not an inline script, so the CSP can forbid inline scripts
      registerType: "autoUpdate",
      manifest: {
        name: "Muninn",
        short_name: "Muninn",
        description: "Your private memory.",
        lang: "en",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#06070c",
        theme_color: "#06070c",
        orientation: "portrait",
        categories: ["productivity", "lifestyle"],
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon-1024.png", sizes: "1024x1024", type: "image/png" },
          { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        shortcuts: [
          { name: "Life", url: "/?view=life", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
          { name: "Ideas digest", url: "/?view=digest", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
        ],
      },
      injectManifest: { globPatterns: ["**/*.{js,css,html,svg,webmanifest}", "icons/icon-192.png", "icons/badge-96.png"] },
    }),
  ],
});
