/**
 * `@opencloud/js` as this CLI resolves it (scripts/build.mjs, tsconfig.json,
 * vitest.config.ts): the vendored browser client, except
 * OPEN_CLOUD_SDK_VERSION. The vendored bundler gives that version to a
 * manifest that pins none, and the CLI chooses it per manifest (buildBundle in
 * ./bundle.ts) rather than take the newest SDK this snapshot ships, which
 * older OpenCloud releases don't install.
 */
export * from "../vendor/browser-client/src/index.js";

/**
 * What a manifest that pins no SDK gets, and what `init` pins: CLI 3.20's
 * default, which every OpenCloud this CLI supports installs. An app that pins
 * none therefore never moves to another SDK on its next deploy.
 */
export const DEFAULT_SDK_VERSION = "2.3.0";

/**
 * What a manifest that pins no SDK but declares containers gets: SDK 2.9.0,
 * whose Functions can call the app's containers. OpenCloud releases without
 * containers refuse such a manifest anyway.
 */
export const CONTAINER_SDK_VERSION = "2.9.0";

/**
 * A live binding the vendored bundler reads while it builds a bundle. Change
 * it only through withUnpinnedSdkVersion.
 */
export let OPEN_CLOUD_SDK_VERSION: string = DEFAULT_SDK_VERSION;

let previous: Promise<unknown> = Promise.resolve();

/**
 * Runs `work` (one bundle build) with `version` as the SDK an unpinned
 * manifest gets. Builds run one at a time, so each reads its own version.
 */
export function withUnpinnedSdkVersion<T>(version: string, work: () => Promise<T>): Promise<T> {
  const current = previous.then(async () => {
    OPEN_CLOUD_SDK_VERSION = version;
    try {
      return await work();
    } finally {
      OPEN_CLOUD_SDK_VERSION = DEFAULT_SDK_VERSION;
    }
  });
  previous = current.catch(() => undefined);
  return current;
}
