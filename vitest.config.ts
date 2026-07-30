import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@opencloud/contracts": path.resolve(
        "vendor/contracts/src/index.ts",
      ),
      "@opencloud/js": path.resolve("vendor/browser-client/src/index.ts"),
      "@opencloud/bundler": path.resolve(
        "vendor/bundler/src/index.ts",
      ),
      "@opencloud/control-plane-client": path.resolve(
        "vendor/control-plane-client/src/index.ts",
      ),
    },
  },
});
