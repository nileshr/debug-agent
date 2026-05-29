import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const workdir =
  process.env.FIXTURE_WORKDIR ??
  path.resolve(import.meta.dirname, "../../../.tmp/todo-fixture-workdir");

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/unit/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@fixture": path.join(workdir, "src"),
    },
  },
});
