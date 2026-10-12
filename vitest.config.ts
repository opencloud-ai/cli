import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These platform packaging/OpenAPI checks require files outside the public snapshot.
    exclude: [
      "**/node_modules/**",
      "vendor/control-plane-client/src/browser-entry.test.ts",
      "vendor/contracts/src/dashboard-privileged.test.ts",
      "vendor/contracts/src/brand-pack.test.ts",
      "vendor/contracts/src/brand-text.test.ts",
      "vendor/contracts/src/cli-installer.test.ts",
      "vendor/contracts/src/installation.test.ts",
    ],
  },
  resolve: {
    alias: {
      "@opencloud/contracts/control-plane": path.resolve("vendor/contracts/src/control-plane.ts"),
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
