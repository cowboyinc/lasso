import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActorEntry, ProjectConfig, RunnerPreferences } from "./types.js";

const DEFAULT_RPC_URL = "https://rpc.mesa.cowboylabs.net";

export const DEFAULT_DASHBOARD_URL = "https://dashboard.mesa.cowboylabs.net";
export const CANYON_DASHBOARD_URL = "https://dashboard.canyon.cowboylabs.net";
export const CANYON_CATTLE_GUARD_URL = "https://cattle-guard.canyon.cowboylabs.net";

const CANYON_RPC_URL = "https://rpc.canyon.cowboylabs.net";

/**
 * dashboard_url resolution: absent → the dashboard matching a known network;
 * explicitly "" (or null) → opt out of dashboard-backed product features;
 * any other string → normalized as given. Scheme-less values default
 * to https — wallet-scoped conversation content flows over this URL, so a
 * project-local config must not silently downgrade it to plaintext; loopback
 * hosts keep http for local dev.
 */
function resolveDashboardUrl(raw: unknown, rpcUrl: string): string | null {
  if (raw === undefined) {
    if (sameOrigin(rpcUrl, CANYON_RPC_URL)) return CANYON_DASHBOARD_URL;
    if (sameOrigin(rpcUrl, DEFAULT_RPC_URL)) return DEFAULT_DASHBOARD_URL;
    return null;
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(trimmed);
  return `${isLoopback ? "http" : "https"}://${trimmed}`;
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin.toLowerCase() === new URL(right).origin.toLowerCase();
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/**
 * Cattle Guard receives replayable wallet proofs, so a project-controlled URL
 * cannot be treated as an arbitrary HTTP destination. Canyon is the only
 * approved remote origin today. Loopback remains available for development.
 */
export function resolveCattleGuardUrl(raw: unknown, rpcUrl: string): string | null {
  if (raw === undefined) {
    return sameOrigin(rpcUrl, CANYON_RPC_URL) ? CANYON_CATTLE_GUARD_URL : null;
  }
  if (typeof raw !== "string" || !raw.trim()) return null;
  const normalized = resolveDashboardUrl(raw, rpcUrl);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    const cleanOrigin =
      url.username === "" &&
      url.password === "" &&
      url.pathname.replace(/\/+$/, "") === "" &&
      url.search === "" &&
      url.hash === "";
    if (!cleanOrigin) return null;
    if (url.origin.toLowerCase() === CANYON_CATTLE_GUARD_URL) return url.origin;
    if (isLoopbackHost(url.hostname) && (url.protocol === "http:" || url.protocol === "https:")) {
      return url.origin;
    }
    return null;
  } catch {
    return null;
  }
}

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

    const validatorUrl = normalizeEndpointUrl(
      typeof target.rpc_url === "string" ? target.rpc_url : DEFAULT_RPC_URL
    ) ?? DEFAULT_RPC_URL;
    return {
      validatorUrl,
      dashboardUrl: resolveDashboardUrl(target.dashboard_url, validatorUrl),
      cattleGuardUrl: resolveCattleGuardUrl(target.cattle_guard_url, validatorUrl),
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
