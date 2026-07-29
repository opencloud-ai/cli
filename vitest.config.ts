import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@opencloud/contracts": path.resolve(
        "vendor/contracts/src/index.ts",
      ),
      "@opencloud/js": path.resolve("vendor/browser-client/src/index.ts"),
    },
  },
});
