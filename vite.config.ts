/**
 * @pwngh/wormdrive
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { defineConfig } from "vite";

/**
 * Vite build/dev config for the wormdrive web app.
 *
 * Two topologies, deliberately different. In dev, Vite owns the origin on :5173
 * and proxies /ws to a separately-run signaling server on :8787, so the app and
 * the relay can iterate independently. In prod (`npm run build` then `npm start`)
 * the signaling server serves dist/ and the websocket from a single port — same
 * origin for both, which keeps the relay reachable without cross-origin/CORS or a
 * second public port to expose.
 */
export default defineConfig({
  build: {
    target: "es2022",
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": {
        // 127.0.0.1, not localhost: on Windows/macOS "localhost" can resolve to
        // IPv6 ::1 first, which the dev signaling server may not be on.
        target: "ws://127.0.0.1:8787",
        ws: true,
      },
    },
  },
});
