/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";

// Relative base so the SPA works whether it is served from the domain root
// (https://vrpose.github.io/) or from a project subpath
// (https://user.github.io/repo/). Combined with hash-based routing this keeps
// deep links and asset URLs valid in both layouts. See README "Despliegue".
export default defineConfig({
  base: "./",
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
