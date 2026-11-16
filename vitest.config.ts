import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname) } },
  esbuild: { jsx: "automatic" },
  test: { environment: "node", setupFiles: [path.resolve(__dirname, "tests/setup.ts")], exclude: ["tests/e2e/**", "tests/integration/**", "node_modules/**"] },
});
