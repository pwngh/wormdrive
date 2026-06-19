import { defineConfig } from "vite";

// Dev: Vite serves the app on :5173 and proxies /ws to the signaling
// server on :8787. Prod: `npm run build` then `npm start` — the signaling
// server serves dist/ and the websocket from a single port.
export default defineConfig({
  build: {
    target: "es2022",
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": {
        target: "ws://localhost:8787",
        ws: true,
      },
    },
  },
});
