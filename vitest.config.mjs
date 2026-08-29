import { defineConfig, coverageConfigDefaults } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["extension/test/**/*.test.js", "server/test/**/*.test.js"],
    coverage: {
      provider: "v8",
      all: true,
      include: ["extension/**/*.js", "server/**/*.js"],
      exclude: [
        ...coverageConfigDefaults.exclude,
        "extension/test/**",
        "server/test/**",
        "extension/config.js",
        "extension/config.example.js",
      ],
      reporter: ["text", "json-summary", "html"],
    },
  },
});
