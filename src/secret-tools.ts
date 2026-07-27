/**
 * Secret bridge tools (COW-2469, part 2/2).
 *
 * The backend agent can ask for a secret to EXIST, never for its value:
 *
 *  - `local_set_secret {name, reason?}` — the backend supplies only the NAME
 *    (and an optional human reason). The VALUE is collected by a local masked
 *    prompt (injected `promptSecret`) and goes straight into the store — it
 *    never appears in tool args, tool results, or the transcript. Cancelling
 *    the prompt cancels the tool.
 *  - `local_get_secret {name}` — returns METADATA ONLY ({exists, backend,
 *    updatedAtMs}); the value never crosses the bridge by design. The agent
 *    references `${NAME}` and a local consumer injects it at use time
 *    (COW-2470).
 *
 * Permission classes: `local_set_secret` is class `secret` — interactive by
 * construction (its only effect is showing the masked capture prompt, which
 * IS the consent step); `local_get_secret` is a metadata `read`.
 */

import type { ClientToolResult, LocalTool } from "./client-tool-bridge.js";
import { validateSecretName, type SecretStore } from "./secret-store.js";

export const SET_SECRET_TOOL_NAME = "local_set_secret";
export const GET_SECRET_TOOL_NAME = "local_get_secret";

/** Reason line rendered inside the masked prompt: bounded and control-free —
 *  it's backend-controlled text shown in a consent UI. */
const MAX_REASON_CHARS = 200;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export interface SetSecretArgs {
  name: string;
  reason?: string;
}

/** Collect a secret value locally (masked). `null` = user cancelled. */
export type PromptSecretFn = (
  name: string,
  reason: string | undefined,
  signal?: AbortSignal
) => Promise<string | null>;

function validateSetArgs(args: unknown): asserts args is SetSecretArgs {
  if (!args || typeof args !== "object") {
    throw new Error("set_secret: args must be an object");
  }
  const a = args as Record<string, unknown>;
  validateSecretName(a.name as string);
  if (a.reason !== undefined) {
    if (
      typeof a.reason !== "string" ||
      a.reason.length > MAX_REASON_CHARS ||
      CONTROL_RE.test(a.reason)
    ) {
      throw new Error("set_secret: reason must be a short single-line string");
    }
  }
}

export function makeSetSecretTool(
  store: SecretStore,
  promptSecret: PromptSecretFn
): LocalTool {
  return {
    name: SET_SECRET_TOOL_NAME,
    permission: "secret",
    validate: (args: unknown) => validateSetArgs(args),
    run: async (args: unknown, signal?: AbortSignal): Promise<ClientToolResult> => {
      const { name, reason } = args as SetSecretArgs;
      const value = await promptSecret(name, reason, signal);
      if (value === null) {
        return { status: "cancelled", reason: "user_cancelled" };
      }
      await store.set(name, value);
      // Metadata only — the value must never ride a tool result.
      return {
        status: "ok",
        output: { name, stored: true, backend: store.backend },
      };
    },
  };
}

export function makeGetSecretTool(store: SecretStore): LocalTool {
  return {
    name: GET_SECRET_TOOL_NAME,
    permission: "read",
    validate: (args: unknown) => {
      validateSecretName((args as { name?: unknown } | null)?.name as string);
    },
    run: async (args: unknown): Promise<ClientToolResult> => {
      const name = (args as { name: string }).name;
      const meta = (await store.list()).find((m) => m.name === name);
      // Metadata can drift (item removed from Keychain Access, corrupt file
      // store): `exists` must reflect a RETRIEVABLE value, or the agent skips
      // re-prompting and injection fails later. The value is checked for
      // presence and immediately discarded — it never rides the result.
      const retrievable = meta !== undefined && (await store.getValue(name)) !== null;
      return {
        status: "ok",
        output:
          meta && retrievable
            ? { name, exists: true, backend: meta.backend, updatedAtMs: meta.updatedAtMs }
            : { name, exists: false },
      };
    },
  };
}
