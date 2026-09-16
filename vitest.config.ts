import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node, not jsdom: everything under test here is server code, or a browser
    // helper written to take its XMLHttpRequest as an injectable dependency,
    // precisely so that testing it needs no DOM.
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      // Not a number to hit — a list of what nothing exercises. The report
      // is read for its uncovered-files column, which is where the next test
      // should go.
      provider: "v8",
      include: ["server/**/*.ts", "web/**/*.ts", "web/**/*.tsx"],
      exclude: ["web/env.d.ts"],
      reporter: ["text-summary", "lcov"],
      reportsDirectory: "coverage",
    },
  },
  resolve: {
    // server/*.ts is compiled with module: NodeNext, so its imports carry .js
    // extensions pointing at files that exist only as .ts before a build.
    extensions: [".ts", ".tsx", ".js", ".json"],
  },
});
