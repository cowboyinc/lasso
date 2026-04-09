import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActorEntry, FeedEntry, ProjectConfig } from "./types.js";

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
    const rawActors: unknown[] = env.actors ?? [];
    const rawFeeds: unknown[] = env.feeds ?? [];
    const actors: ActorEntry[] = rawActors.map((a) =>
      typeof a === "string" ? { address: a, label: "" } : (a as ActorEntry)
    );
    const feeds: FeedEntry[] = rawFeeds.map((feed) =>
      typeof feed === "string" ? { id: feed } : (feed as FeedEntry)
    );
    return {
      validatorUrl: env.rpc_url ?? DEFAULT_RPC_URL,
      dashboardUrl: env.dashboard_url ?? null,
      walletAddress: env.wallet_address ?? null,
      actors,
      feeds,
    };
  } catch {
    return null;
  }
}

/**
 * Merge the actors array into the active environment in .cowboy/config.json.
 * Preserves all other fields (key_file, rpc_url, watchtower_registry, etc).
 */
export function saveActors(actors: ActorEntry[]): void {
  const config = loadRawConfig();
  if (!config) return;
  const active = config.active;
  config.environments[active].actors = actors;
  writeConfig(config);
}

export function saveFeeds(feeds: FeedEntry[]): void {
  const config = loadRawConfig();
  if (!config) return;
  const active = config.active;
  config.environments[active].feeds = feeds;
  writeConfig(config);
}

function loadRawConfig(): any | null {
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const config = JSON.parse(raw);
  const active = config?.active;
  if (!active || !config?.environments?.[active]) {
    return null;
  }
  return config;
}

function writeConfig(config: any): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}
