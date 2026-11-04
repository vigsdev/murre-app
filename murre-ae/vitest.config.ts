import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts, which carries the CEP build plugins.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
