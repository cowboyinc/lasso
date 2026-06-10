import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActorEntry, ProjectConfig, RunnerPreferences } from "./types.js";

const DEFAULT_RPC_URL = "https://rpc.mesa.cowboylabs.net";

const DEFAULT_RUNNER_PREFERENCES: RunnerPreferences = {
  primaryRunner: null,
  helperRunner: null,
  smallPromptRouting: true,
};

export function normalizeEndpointUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

function normalizeActors(rawActors: unknown): ActorEntry[] {
  if (!Array.isArray(rawActors)) return [];
  return rawActors.map((entry) =>
    typeof entry === "string"
      ? { address: entry, label: "" }
      : ({
          address: String((entry as { address?: unknown }).address ?? ""),
          label: String((entry as { label?: unknown }).label ?? ""),
        })
  );
}

function normalizeRunnerPreferences(raw: unknown): RunnerPreferences {
  const prefs = (raw ?? {}) as Record<string, unknown>;
  return {
    primaryRunner:
      typeof prefs.primaryRunner === "string" && prefs.primaryRunner.trim()
        ? prefs.primaryRunner
        : null,
    helperRunner:
      typeof prefs.helperRunner === "string" && prefs.helperRunner.trim()
        ? prefs.helperRunner
        : null,
    smallPromptRouting:
      typeof prefs.smallPromptRouting === "boolean"
        ? prefs.smallPromptRouting
        : DEFAULT_RUNNER_PREFERENCES.smallPromptRouting,
  };
}

function getConfigPath(): string {
  return join(process.cwd(), ".cowboy", "config.json");
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(getConfigPath(), "utf-8")) as Record<string, unknown>;
}

function resolveConfigTarget(
  config: Record<string, unknown>
): Record<string, unknown> | null {
  const active =
    typeof config.active === "string"
      ? config.active
      : typeof config.network === "string"
        ? config.network
        : null;
  const environments = config.environments as Record<string, Record<string, unknown>> | undefined;

  if (active && environments?.[active]) {
    return environments[active];
  }

  if ("rpc_url" in config || "dashboard_url" in config || "wallet_address" in config || "actors" in config) {
    return config;
  }

  return null;
}

/**
 * Read the active environment from .cowboy/config.json in the current directory.
 * Supports both the newer `active/environments` shape and the older flat shape.
 */
export function loadProjectConfig(): ProjectConfig | null {
  try {
    const config = readConfig();
    const target = resolveConfigTarget(config);
    if (!target) {
      return null;
    }

    return {
      validatorUrl: normalizeEndpointUrl(typeof target.rpc_url === "string" ? target.rpc_url : DEFAULT_RPC_URL) ?? DEFAULT_RPC_URL,
      dashboardUrl: normalizeEndpointUrl(typeof target.dashboard_url === "string" ? target.dashboard_url : null),
      walletAddress: typeof target.wallet_address === "string" ? target.wallet_address : null,
      runnerUrl: normalizeEndpointUrl(typeof target.runner_url === "string" ? target.runner_url : null),
      actors: normalizeActors(target.actors),
      runnerPreferences: normalizeRunnerPreferences(target.lasso),
    };
  } catch {
    return null;
  }
}

function updateProjectConfig(mutator: (target: Record<string, unknown>) => void): void {
  const config = readConfig();
  const target = resolveConfigTarget(config);
  if (!target) return;
  mutator(target);
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + "\n");
}

/**
 * Merge the actors array into the active environment in .cowboy/config.json.
 * Preserves all other fields.
 */
export function saveActors(actors: ActorEntry[]): void {
  updateProjectConfig((target) => {
    target.actors = actors;
  });
}

export function saveRunnerPreferences(runnerPreferences: RunnerPreferences): void {
  updateProjectConfig((target) => {
    target.lasso = {
      ...DEFAULT_RUNNER_PREFERENCES,
      ...normalizeRunnerPreferences(target.lasso),
      ...runnerPreferences,
    };
  });
}
