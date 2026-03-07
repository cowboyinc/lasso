import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { LassoConfig } from "./types.js";

const CONFIG_DIR = join(homedir(), ".lasso");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

const DEFAULT_RPC_URL = "http://localhost:4000";

/**
 * Read rpc_url from .cowboy/config.json in the current directory.
 * Mirrors the CLI's discover_rpc_url logic: reads "active" environment,
 * then gets its "rpc_url". Returns undefined if not found.
 */
function discoverProjectRpcUrl(): string | undefined {
  try {
    const raw = readFileSync(join(process.cwd(), ".cowboy", "config.json"), "utf-8");
    const config = JSON.parse(raw);
    const active = config?.active;
    if (active && config?.environments?.[active]?.rpc_url) {
      return config.environments[active].rpc_url;
    }
  } catch {
    // No .cowboy/config.json or invalid JSON
  }
  return undefined;
}

export function loadConfig(): LassoConfig {
  // Priority: ~/.lasso/config.json > .cowboy/config.json > localhost fallback
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<LassoConfig>;
    if (parsed.validatorUrl) {
      return { validatorUrl: parsed.validatorUrl, ...parsed };
    }
  } catch {
    // No ~/.lasso/config.json
  }

  const projectUrl = discoverProjectRpcUrl();
  return { validatorUrl: projectUrl ?? DEFAULT_RPC_URL };
}

export function saveConfig(config: LassoConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}
