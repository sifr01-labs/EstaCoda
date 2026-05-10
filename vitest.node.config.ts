import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: [
      "node_modules",
      "dist",
      // Tests that import bun:sqlite — only runnable under Bun
      "src/cli/cli-sessions.test.ts",
      "src/cli/gateway-commands.test.ts",
      "src/cron/cron-command.test.ts",
      "src/cron/cron-execution-store.test.ts",
      "src/cron/cron-runner.test.ts",
    ],
    setupFiles: ["src/test/vitest-setup.ts"],
    reporters: ["verbose"],
  },
  resolve: {
    alias: {
      "^(.+)\\.js$": "$1"
    }
  }
});
