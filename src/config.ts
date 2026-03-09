import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig } from "./types.js";

const CONFIG_PATH = join(process.cwd(), ".cowboy", "config.json");
const DEFAULT_RPC_URL = "http://localhost:4000";

/**
 * Read the active environment from .cowboy/config.json in the current directory.
 * Returns ProjectConfig with validatorUrl, walletAddress, and actors,
 * or null if no project config exists.
 */
export function loadProjectConfig(): ProjectConfig | null {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw);
    const active = config?.active;
    if (!active || !config?.environments?.[active]) {
      return null;
    }
    const env = config.environments[active];
    return {
      validatorUrl: env.rpc_url ?? DEFAULT_RPC_URL,
      walletAddress: env.wallet_address ?? null,
      actors: env.actors ?? [],
    };
  } catch {
    return null;
  }
}

/**
 * Merge the actors array into the active environment in .cowboy/config.json.
 * Preserves all other fields (key_file, rpc_url, watchtower_registry, etc).
 */
export function saveActors(actors: string[]): void {
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const config = JSON.parse(raw);
  const active = config?.active;
  if (!active || !config?.environments?.[active]) {
    return;
  }
  config.environments[active].actors = actors;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}
