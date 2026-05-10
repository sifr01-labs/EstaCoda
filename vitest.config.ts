import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    setupFiles: ["src/test/vitest-setup.ts"],
    reporters: ["verbose"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/smoke/**", "src/test/fakes/**"]
    }
  },
  resolve: {
    alias: {
      "^(.+)\\.js$": "$1"
    }
  }
});
