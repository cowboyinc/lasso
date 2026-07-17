/**
 * Client-tool bridge (COW-2455).
 *
 * Generalizes the specialized signing broker into a request/resume protocol
 * between the backend agent loop and this local client: the backend asks the
 * client to run a named local tool and awaits the result over the same stream.
 *
 * This module is the internal core — pure, no fetch / no fs / no CLI. It owns:
 *   - the wire-stable INTERNAL types the rest of lasso consumes,
 *   - the adapters that normalize backend events into those types (the one
 *     place the assumed backend wire shape is decoded — see COW-2455 for the
 *     provisional contract),
 *   - the local tool registry + dispatch.
 *
 * The backend wire side is not finalized (owner traveling); everything here is
 * isolated behind `requestFrom*` adapters so a rename is a one-file change.
 */

import type { ToolPendingSignatureEvent } from "./agent-client.js";
import type { EcdsaSignature } from "./signer.js";

/** A request from the backend to run a local tool, normalized from the wire. */
export interface ClientToolRequest {
  toolUseId: string;
  toolName: string;
  args: unknown;
  /** Optional human summary for the approval UI (COW-2463). */
  summary?: string;
}

/** Why a request ended without a tool result. Kept distinct from `error` so the
 *  backend can tell an explicit user denial from an infrastructure failure —
 *  do NOT collapse `user_cancelled` into `error`. Mirrors the backend broker's
 *  cancel reasons. */
export type ClientToolCancelReason =
  | "user_cancelled"
  | "timeout"
  | "stream_closed"
  | "agent_aborted";

/** The outcome the client posts back to resume the loop. */
export type ClientToolResult =
  | { status: "ok"; output: unknown }
  | { status: "error"; output: unknown; errorCode?: string }
  | { status: "cancelled"; reason: ClientToolCancelReason };

/** A local capability the agent can invoke. `validate` treats `args` as
 *  untrusted and throws on a bad shape; `run` executes an already-validated
 *  request. Keeping them separate lets the registry surface a clean
 *  `invalid_args` result without the tool implementing that plumbing. */
export interface LocalTool {
  name: string;
  /** Throw (any Error) if `args` is malformed. */
  validate: (args: unknown) => void;
  run: (args: unknown) => Promise<ClientToolResult>;
}

/** Registry of local tools + dispatch. The set of registered names is also the
 *  capability advertisement for the handshake (COW-2456) — do NOT register a
 *  tool the client isn't ready to run safely (writes/exec must wait for the
 *  permission gate + sandbox). */
export class ToolRegistry {
  private readonly tools = new Map<string, LocalTool>();

  register(tool: LocalTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`local tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Names to advertise to the backend (COW-2456), sorted for determinism. */
  supportedNames(): string[] {
    return [...this.tools.keys()].sort();
  }

  /** Validate + run a request. Never throws: an unknown tool or malformed args
   *  becomes a structured `error` result so the loop gets an actionable answer
   *  instead of the stream dying. */
  async dispatch(req: ClientToolRequest): Promise<ClientToolResult> {
    const tool = this.tools.get(req.toolName);
    if (!tool) {
      return {
        status: "error",
        errorCode: "unknown_tool",
        output: { message: `unsupported local tool: ${req.toolName}` },
      };
    }
    try {
      tool.validate(req.args);
    } catch (err) {
      return {
        status: "error",
        errorCode: "invalid_args",
        output: { message: err instanceof Error ? err.message : String(err) },
      };
    }
    try {
      return await tool.run(req.args);
    } catch (err) {
      return {
        status: "error",
        errorCode: "tool_failed",
        output: { message: err instanceof Error ? err.message : String(err) },
      };
    }
  }
}

// ── Wire adapters — the ONLY place backend event shapes are decoded ──────────

/** Assumed generic event shape (COW-2455, provisional). Decoded here so the
 *  rest of lasso never touches the raw wire type. */
export interface ClientToolRequestEventLike {
  toolUseId: string;
  toolName: string;
  args: unknown;
  summary?: string;
}

export function requestFromClientToolEvent(
  ev: ClientToolRequestEventLike
): ClientToolRequest {
  return {
    toolUseId: ev.toolUseId,
    toolName: ev.toolName,
    args: ev.args,
    summary: ev.summary,
  };
}

/** Canonical internal name for the local signing capability. The legacy
 *  `tool_pending_signature` event maps onto this so signing flows through the
 *  same registry as any other tool — while still posting back over the existing
 *  sign-callback wire (dual-path) until the backend generalizes. */
export const SIGN_TOOL_NAME = "cowboy.signHash";

/** Extract the 32-byte signing hash from a legacy pending-signature payload. */
function hashHexFromPayload(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "hashHex" in payload) {
    const h = (payload as { hashHex: unknown }).hashHex;
    if (typeof h === "string" && h.length > 0) return h;
  }
  return null;
}

/** Adapt the legacy `tool_pending_signature` event onto the generic request so
 *  it dispatches through the registry as the `cowboy.signHash` tool. Returns
 *  null when the payload carries no hash (caller falls back to the legacy
 *  notice). */
export function requestFromPendingSignature(
  ev: ToolPendingSignatureEvent
): ClientToolRequest | null {
  const hashHex = hashHexFromPayload(ev.preview.payload);
  if (!hashHex) return null;
  return {
    toolUseId: ev.toolUseId,
    toolName: SIGN_TOOL_NAME,
    args: { hashHex },
    summary: ev.preview.summary,
  };
}

// ── Signing tool ─────────────────────────────────────────────────────────────

/** 0x-prefixed 32-byte hash, i.e. exactly 64 hex chars. */
const HASH_HEX_RE = /^0x[0-9a-fA-F]{64}$/;

export interface SignHashArgs {
  hashHex: string;
}

/** Build the local signing tool. `signHash` is injected (the CLI shell-out in
 *  production, a fake in tests) so this stays pure. Validates the hash shape
 *  before signing — `args` is untrusted. */
export function makeSignTool(
  signHash: (hashHex: string) => Promise<EcdsaSignature>
): LocalTool {
  return {
    name: SIGN_TOOL_NAME,
    validate: (args: unknown) => {
      const hashHex = (args as Partial<SignHashArgs> | null)?.hashHex;
      if (typeof hashHex !== "string" || !HASH_HEX_RE.test(hashHex)) {
        throw new Error("signHash: args.hashHex must be a 0x-prefixed 32-byte hex string");
      }
    },
    run: async (args: unknown): Promise<ClientToolResult> => {
      const { hashHex } = args as SignHashArgs;
      const signature = await signHash(hashHex);
      return { status: "ok", output: signature };
    },
  };
}
