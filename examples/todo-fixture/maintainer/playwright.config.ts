import path from "node:path";
import { defineConfig } from "@playwright/test";

const baseURL = process.env.FIXTURE_URL ?? "http://localhost:5199";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL,
    channel: "chrome",
  },
  webServer: process.env.FIXTURE_SKIP_WEBSERVER
    ? undefined
    : {
        command: "npm run dev",
        cwd:
          process.env.FIXTURE_WORKDIR ??
          path.resolve(import.meta.dirname, "../../../.tmp/todo-fixture-workdir"),
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
