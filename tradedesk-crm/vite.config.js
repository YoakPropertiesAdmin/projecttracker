import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // autoUpdate: the service worker replaces itself as soon as a new build
      // is deployed. Important here — a stale shell against a live database is
      // worse than no service worker at all.
      registerType: "autoUpdate",
      includeAssets: ["apple-touch-icon.png", "favicon-64.png"],
      manifest: {
        name: "TradeDesk — Job & Payment Tracker",
        short_name: "TradeDesk",
        description: "Track a job from signed contract to closed: stage, client payments, vendor payables.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "any",
        background_color: "#F5F2EC",
        theme_color: "#2B2721",
        icons: [
          { src: "/pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512.png", sizes: "512x512", type: "image/png" },
          { src: "/pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Precache the shell only. Job data is deliberately NOT cached: this is
        // a shared live database, and serving a stale ledger from disk would
        // reintroduce exactly the last-write-wins problem the relational
        // migration removed. Supabase calls always go to the network.
        globPatterns: ["**/*.{js,css,html,png,svg,woff2}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/rest\//, /^\/auth\//, /^\/functions\//],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: { port: 5173 },
});
