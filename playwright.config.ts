import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import { fakeKey } from "./tests/fixtures/shared-ai-provider";

const ci = Boolean(process.env.CI);
const fakeAi = process.env.UPCOMER_E2E_FAKE_AI === "true";

export default defineConfig({
  testDir: "./tests/e2e",
  // On CI, also write an HTML report and keep traces of failed tests, so a failed run can be inspected from its artifact.
  reporter: ci ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: "http://127.0.0.1:3000", trace: ci ? "retain-on-failure" : "off" },
  webServer: {
    // A production build serves every page precompiled. `next dev` compiles each page on its first request, which can
    // outlast the 5-second waits after a navigation while several workers hit a fresh server.
    command: fakeAi ? "npx next start --port 3000" : "npm run build && npx next start --port 3000",
    env: fakeAi ? {
      NODE_OPTIONS: `--require "${resolve("tests/fixtures/redirect-deepseek.cjs").replaceAll("\\", "/")}"`,
      DEEPSEEK_API_KEY: fakeKey,
      AI_PRACTICE_GENERATION_ENABLED: "true",
      AI_MOCK_FEEDBACK_ENABLED: "true",
    } : undefined,
    url: "http://127.0.0.1:3000",
    // Locally, a server already on port 3000 (for example `npm run dev`) is reused instead; CI always builds.
    reuseExistingServer: !ci && !fakeAi,
    // Room for `next build` before the server starts answering.
    timeout: 300_000,
  },
});
