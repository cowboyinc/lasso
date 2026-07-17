/**
 * Local actor simulation for the client-tool bridge (COW-2461).
 *
 * Lasso runs on the user's machine, so it can simulate an actor handler LOCALLY
 * against the deterministic PVM (via the `cowboy` CLI) instead of round-tripping
 * to a remote runner — faster, offline. Simulation has no chain side effects
 * (no tx, no funds, no committed state); the PVM is a no-I/O, no-network, no
 * clock/random sandbox, so the executed actor code can't touch the machine.
 *
 * Security posture (COW-2461, per design review):
 *   - args are backend-controlled → validated hard (handler is an identifier,
 *     payload is bounded hex, limits are bounded ints, code is size-capped).
 *   - a source `actorPath` is a READ over project files → gated through the same
 *     project sandbox as writes (must be a plain in-project file); inline `code`
 *     is preferred and runs from a temp file we own, never a backend path.
 *   - bounded: per-call timeout (via the dispatch signal) + a combined
 *     stdout/stderr cap kill a runaway `cowboy` child.
 *   - the result is ADVISORY: a local pass is not on-chain truth (the local PVM
 *     may differ from the runner's), and absolute paths are redacted from any
 *     surfaced text so simulation can't become a filesystem oracle.
 *
 * The exact `cowboy dev` flag/stdout contract is isolated in the two ADAPTER
 * functions below (the CLI isn't available in every dev env), so confirming it
 * is a one-place change — the validation, sandboxing, and result shape the rest
 * of lasso depends on don't move.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCowboyAsync } from "./executor.js";
import { classifyWritePath } from "./path-sandbox.js";
import type { ClientToolResult, LocalTool } from "./client-tool-bridge.js";

/** Canonical bridge name for local simulation (COW-2461). */
export const SIMULATE_TOOL_NAME = "cowboy.simulate";

// ── Bounds (backend-controlled input is untrusted) ───────────────────────────

/** Dotted identifier: `handler`, `Actor.method`. No leading `-` (argv-flag). */
const HANDLER_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const PAYLOAD_HEX_RE = /^(0x)?[0-9a-fA-F]*$/;
const MAX_PAYLOAD_HEX = 64 * 1024; // 32 KiB of bytes
const MAX_CODE_BYTES = 512 * 1024;
const MAX_LIMIT = 1_000_000_000;
/** Combined stdout+stderr cap for the CLI child (COW-2461). */
export const MAX_SIMULATE_OUTPUT_BYTES = 1 * 1024 * 1024;

export interface SimulateArgs {
  /** In-project source file to simulate (sandbox-checked). Mutually exclusive
   *  with `code`. */
  actorPath?: string;
  /** Inline actor source (preferred — no project-file oracle). Written to a
   *  temp file we own for the run. Mutually exclusive with `actorPath`. */
  code?: string;
  /** Handler to invoke. */
  handler: string;
  /** CBOR/hex payload (optional). */
  payload?: string;
  cyclesLimit?: number;
  cellsLimit?: number;
}

/** Throw (any Error) if `args` is not a well-formed, in-bounds SimulateArgs.
 *  Used as the tool's `validate` and by the `/simulate` command. */
export function validateSimulateArgs(args: unknown): asserts args is SimulateArgs {
  if (!args || typeof args !== "object") {
    throw new Error("simulate: args must be an object");
  }
  const a = args as Record<string, unknown>;

  const hasPath = typeof a.actorPath === "string" && a.actorPath.length > 0;
  const hasCode = typeof a.code === "string" && a.code.length > 0;
  if (hasPath === hasCode) {
    throw new Error("simulate: provide exactly one of `actorPath` or `code`");
  }
  // Measure actual bytes, not UTF-16 code units, so multibyte source can't
  // overshoot the cap.
  if (hasCode && Buffer.byteLength(a.code as string, "utf8") > MAX_CODE_BYTES) {
    throw new Error(`simulate: code exceeds ${MAX_CODE_BYTES} bytes`);
  }

  if (typeof a.handler !== "string" || !HANDLER_RE.test(a.handler)) {
    throw new Error("simulate: handler must be an identifier (no leading '-')");
  }

  if (a.payload !== undefined) {
    if (
      typeof a.payload !== "string" ||
      !PAYLOAD_HEX_RE.test(a.payload) ||
      a.payload.length > MAX_PAYLOAD_HEX
    ) {
      throw new Error("simulate: payload must be bounded hex");
    }
  }

  for (const key of ["cyclesLimit", "cellsLimit"] as const) {
    const v = a[key];
    if (v !== undefined) {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_LIMIT) {
        throw new Error(`simulate: ${key} must be an integer in [1, ${MAX_LIMIT}]`);
      }
    }
  }
}

// ── Result shape (stable; the rest of lasso depends on this, not the CLI) ─────

export interface SimulateResult {
  status: "ok" | "error";
  cyclesUsed?: number;
  cellsUsed?: number;
  stateChanges?: unknown;
  events?: unknown;
  logs?: string;
  error?: string;
  /** Always true: a local pass is not on-chain truth (parity may differ). */
  advisory: true;
  simulator: "local";
}

/** Redact absolute paths from surfaced text so simulation can't leak the
 *  filesystem layout. Each `[needle, replacement]` is substituted in order —
 *  redact more-specific prefixes (temp dir) before broader ones (home). */
export function redactAbsolutePaths(
  text: string,
  replacements: Array<[string, string]>
): string {
  let out = text;
  for (const [needle, repl] of replacements) {
    if (needle) out = out.split(needle).join(repl);
  }
  return out;
}

// ── ADAPTER: the only place the `cowboy dev` contract is assumed ─────────────

/** Build the argv for a local simulate. ASSUMED CONTRACT (COW-2461): mirrors the
 *  `actor execute` flags. Confirm against the shipped `cowboy dev` and adjust
 *  here only. Positional user values never appear — everything is `--flag value`
 *  with a hard-validated `handler`, so there is no argv-injection surface. */
export function buildSimulateArgv(sourceFile: string, args: SimulateArgs): string[] {
  const argv = ["dev", "--actor", sourceFile, "--handler", args.handler];
  if (args.payload !== undefined) argv.push("--payload", args.payload);
  argv.push("--cycles-limit", String(args.cyclesLimit ?? 500_000));
  argv.push("--cells-limit", String(args.cellsLimit ?? 500_000));
  argv.push("--json");
  return argv;
}

/** Parse `cowboy dev` stdout into a stable SimulateResult. ASSUMED CONTRACT:
 *  a JSON object as the FINAL non-empty line of output. Only that line is
 *  authoritative — anything the simulated actor prints happens mid-run, before
 *  the CLI emits its result, so an actor `print('{"status":"ok"}')` cannot
 *  spoof a pass (an earlier `{...}` line is never consulted). Falls back to a
 *  plain error result. Pure. */
export function parseSimulateOutput(stdout: string, exitCode: number): SimulateResult {
  const base = { advisory: true, simulator: "local" } as const;
  const lines = stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const lastLine = lines[lines.length - 1];
  const line = lastLine?.startsWith("{") ? lastLine : undefined;

  if (!line) {
    // We asked for `--json`; no JSON object means we can't trust a pass (old CLI,
    // `--json` ignored, or a crash before output). Fail rather than false-pass.
    return {
      ...base,
      status: "error",
      error: "simulate: no JSON result in output (unexpected simulator output)",
      logs: stdout.slice(0, 4000) || undefined,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { ...base, status: "error", error: "simulate: malformed JSON result" };
  }

  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const errorText =
    typeof parsed.error === "string" ? parsed.error : undefined;

  const hasStatus = typeof parsed.status === "string";
  const hasOk = typeof parsed.ok === "boolean";
  const hasSimFields = [
    "cycles_used",
    "cyclesUsed",
    "cells_used",
    "cellsUsed",
    "state_changes",
    "stateChanges",
    "events",
  ].some((k) => k in parsed);

  // A JSON object that carries none of the recognized simulate fields is not a
  // result we can trust — an old/incompatible CLI or a stray diagnostic line.
  // Never render it as a pass.
  if (!hasStatus && !hasOk && !hasSimFields && !errorText) {
    return {
      ...base,
      status: "error",
      error: "simulate: unexpected simulator output (no recognized result fields)",
    };
  }

  // An EXPLICIT status/flag wins over the exit-code fallback, so a
  // `{"status":"error"}` (or `{"ok":false}`) never reads as a pass just because
  // the process exited 0. Any error string also forces failure.
  let ok: boolean;
  if (hasStatus) ok = parsed.status === "ok";
  else if (hasOk) ok = parsed.ok as boolean;
  else ok = exitCode === 0;
  if (errorText) ok = false;
  // A non-zero exit is never a pass, even if an `{"status":"ok"}` line was
  // printed before the process failed (e.g. the output cap killed it mid-run).
  if (exitCode !== 0) ok = false;

  return {
    ...base,
    status: ok ? "ok" : "error",
    cyclesUsed: num(parsed.cycles_used ?? parsed.cyclesUsed),
    cellsUsed: num(parsed.cells_used ?? parsed.cellsUsed),
    stateChanges: parsed.state_changes ?? parsed.stateChanges,
    events: parsed.events,
    logs: typeof parsed.logs === "string" ? parsed.logs : undefined,
    error: errorText,
  };
}

// ── Runner (assumes already-validated args) ──────────────────────────────────

export interface RunSimulateOptions {
  /** Project root for sandboxing a source path + redaction. Defaults to cwd. */
  root?: string;
  /** Home dir to redact. Defaults to $HOME. */
  home?: string;
  /** Abort (timeout / Ctrl-C) — kills the CLI child. */
  signal?: AbortSignal;
}

/**
 * Run a local simulation and return a bridge result. Assumes `args` already
 * passed `validateSimulateArgs`. Resolves the source safely (inline `code` →
 * a temp file we own; `actorPath` → must be a plain in-project file), runs the
 * CLI bounded by an output cap + the abort signal, and returns a redacted,
 * advisory-marked result.
 */
export async function runLocalSimulate(
  args: SimulateArgs,
  opts: RunSimulateOptions = {}
): Promise<ClientToolResult> {
  const root = opts.root ?? process.cwd();
  const home = opts.home ?? process.env.HOME ?? "";

  // Redaction set, built up as paths become known. classifyWritePath anchors the
  // source on realpath(root), so redact both the given AND canonical forms of
  // root/home (a symlinked project would otherwise leak its real path), plus the
  // temp dir once created. Used for BOTH the result and any thrown-error message.
  const canonical = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const redactions: Array<[string, string]> = [];
  const addRedaction = (p: string, repl: string) => {
    if (p && !redactions.some(([n]) => n === p)) redactions.push([p, repl]);
  };
  addRedaction(root, ".");
  addRedaction(canonical(root), ".");
  addRedaction(home, "~");
  addRedaction(canonical(home), "~");
  // Redact the tmp base up front, so even a `mkdtempSync` failure (read-only
  // /tmp, permissions) can't leak the absolute temp path in the error message.
  addRedaction(tmpdir(), "<tmp>");
  addRedaction(canonical(tmpdir()), "<tmp>");

  let tempDir: string | null = null;
  try {
    let sourceFile: string;
    if (args.code !== undefined) {
      // Inline source: write to a temp file we control — never a backend path.
      tempDir = mkdtempSync(join(tmpdir(), "lasso-sim-"));
      addRedaction(tempDir, "<tmp>");
      addRedaction(canonical(tempDir), "<tmp>");
      sourceFile = join(tempDir, "actor.py");
      writeFileSync(sourceFile, args.code, "utf-8");
    } else {
      // Path-based: a read over project files — must be plainly in-project.
      const cls = classifyWritePath(args.actorPath as string, root);
      if (cls.scope !== "inside") {
        return {
          status: "error",
          errorCode: "invalid_args",
          output: { message: `simulate: source path is not an in-project file (${cls.scope})` },
        };
      }
      sourceFile = cls.resolved;
    }

    const { stdout, stderr, exitCode, truncated } = await executeCowboyAsync(
      buildSimulateArgv(sourceFile, args),
      undefined,
      opts.signal,
      MAX_SIMULATE_OUTPUT_BYTES
    );
    // Parse each stream separately — joining them would displace the JSON from
    // its authoritative final-line position. stdout is canonical; fall back to
    // stderr only when stdout carries no result (some CLIs report there), and
    // keep the non-authoritative stream as diagnostics either way.
    let result = parseSimulateOutput(stdout, exitCode);
    let diagnostics = stderr;
    if (result.status === "error" && result.error?.startsWith("simulate: no JSON result") && stderr.trim()) {
      const fromStderr = parseSimulateOutput(stderr, exitCode);
      if (!fromStderr.error?.startsWith("simulate: no JSON result")) {
        result = fromStderr;
        diagnostics = stdout;
      }
    }
    if (diagnostics.trim()) {
      result.logs = [result.logs, diagnostics.slice(0, 4000)].filter(Boolean).join("\n");
    }
    // A capped/truncated run is never a pass, even if an OK JSON line survived
    // before the kill (the child may have exited 0 or trapped SIGTERM).
    if (truncated && result.status !== "error") {
      result.status = "error";
      result.error = "simulate: output exceeded the size cap (truncated)";
    }

    if (result.error) result.error = redactAbsolutePaths(result.error, redactions);
    if (result.logs) result.logs = redactAbsolutePaths(result.logs, redactions);
    // Structured fields can carry absolute paths too (e.g. an actor surfaces
    // `__file__`, or the simulator embeds source locations) — redact through a
    // round-trip so nothing we return leaks the filesystem layout.
    const redactValue = (v: unknown): unknown => {
      if (v == null) return v;
      try {
        return JSON.parse(redactAbsolutePaths(JSON.stringify(v), redactions));
      } catch {
        return v;
      }
    };
    result.stateChanges = redactValue(result.stateChanges);
    result.events = redactValue(result.events);
    return { status: "ok", output: result };
  } catch (err) {
    // Setup (temp write) or unexpected failure — surface a structured, redacted
    // error instead of letting a raw message (with an absolute path) escape.
    const raw = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      errorCode: "tool_failed",
      output: { message: redactAbsolutePaths(raw, redactions) },
    };
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

/** The `simulate` bridge tool (COW-2461). Co-located here (not in the pure
 *  bridge module) because its validation + CLI runner live here; the bridge only
 *  holds the `LocalTool` shape. Permission class `simulate`: default asks, auto
 *  auto-approves (sandboxed local compute). */
export function makeSimulateTool(): LocalTool {
  return {
    name: SIMULATE_TOOL_NAME,
    permission: "simulate",
    validate: (args: unknown) => validateSimulateArgs(args),
    run: (args: unknown, signal?: AbortSignal) =>
      runLocalSimulate(args as SimulateArgs, { signal }),
  };
}
