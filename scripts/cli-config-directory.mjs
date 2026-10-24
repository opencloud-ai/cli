import path from "node:path";

/**
 * The per-user configuration directory the CLI uses for the given HOME and
 * XDG_CONFIG_HOME, as src/credential-store.ts resolves it. macOS ignores
 * XDG_CONFIG_HOME.
 */
export function cliConfigDirectory({ home, configHome }) {
  return process.platform === "darwin"
    ? path.join(home, "Library", "Application Support", "OpenCloud")
    : path.join(configHome, "opencloud");
}
