import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/node_modules.nosync/**"],
    setupFiles: ["./tests/vitest.setup.ts"],
  },
});
