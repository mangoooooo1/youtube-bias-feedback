import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["extension/test/**/*.test.js", "server/test/**/*.test.js"],
  },
});
