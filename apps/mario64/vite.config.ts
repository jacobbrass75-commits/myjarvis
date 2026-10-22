import { defineConfig } from "vite";
import { resolve } from "node:path";

// One origin for everything: pages from Vite, /ws proxied to relay.ts. Open from the phone at
// http://<mac-lan-ip>:5174/controller.html and load glasses.html in the Even App (npm run qr).
export default defineConfig({
  server: {
    proxy: { "/ws": { target: `ws://localhost:${process.env.M64_PORT ?? 8790}`, ws: true } },
  },
  build: {
    target: "es2020",
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        glasses: resolve(__dirname, "glasses.html"),
        controller: resolve(__dirname, "controller.html"),
      },
    },
  },
});
