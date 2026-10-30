/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";

// Build stamp: YYYYMMDDHHMM in UTC-3 (Argentina), computed at config load time
// (i.e. when `vite build` / `vite` starts). Injected as the global __BUILD__ so
// the UI can show which version is live. Example: 202610300205.
const nowUtc3 = new Date(Date.now() - 3 * 60 * 60 * 1000);
const pad = (n: number): string => String(n).padStart(2, "0");
const BUILD_ID = [
  nowUtc3.getUTCFullYear(),
  pad(nowUtc3.getUTCMonth() + 1),
  pad(nowUtc3.getUTCDate()),
  pad(nowUtc3.getUTCHours()),
  pad(nowUtc3.getUTCMinutes()),
].join("");

// Relative base so the SPA works whether it is served from the domain root
// (https://vrpose.github.io/) or from a project subpath
// (https://user.github.io/repo/). Combined with hash-based routing this keeps
// deep links and asset URLs valid in both layouts. See README "Despliegue".
export default defineConfig({
  base: "./",
  define: {
    __BUILD__: JSON.stringify(BUILD_ID),
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  test: {
    // Pure coordinate-math / protocol tests run in Node; no DOM needed.
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
