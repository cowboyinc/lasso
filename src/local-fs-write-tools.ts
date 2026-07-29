/**
 * Local FS tools — write side (COW-2458, PR 2/2).
 *
 * `local_write_file` (create/overwrite) and `local_patch_file` (surgical edit,
 * mirroring the backend `patch_workspace_file`). Both are `write`-class, so the
 * approval gate governs them: dispatch classifies the target through the same
 * project sandbox and `decideWrite(scope, mode)` — a traversal/escape OR an
 * outside-the-project target is denied (agent writes stay in the project), a
 * protected in-project target always asks (even in `auto`), and a plain
 * in-project target auto-approves only in `auto`. The tools here run AFTER that
 * decision; they defensively re-refuse `invalid`/`outside` and always write to
 * the CANONICAL resolved path atomically.
 *
 * `applyEdit` is a faithful port of the backend's edit semantics (exact-unique
 * with a whitespace-insensitive line-block fallback) so the model's habits from
 * the CBFS `patch_workspace_file` tool transfer 1:1. Hand-mirrored — kept in
 * sync via a shared test fixture until a shared-protocol package exists (drift
 * risk tracked with COW-2473).
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  chmodSync,
  lstatSync,
  openSync,
  readSync,
  closeSync,
  statSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { classifyWritePath } from "./path-sandbox.js";
import type { ClientToolResult, LocalTool } from "./client-tool-bridge.js";

export const WRITE_FILE_TOOL_NAME = "local_write_file";
export const PATCH_FILE_TOOL_NAME = "local_patch_file";

/** Max bytes for a written file / a patch's resulting file. */
const MAX_WRITE_BYTES = 5 * 1024 * 1024;
/** Max size of a file `local_patch_file` will open. */
const MAX_PATCH_FILE_BYTES = 5 * 1024 * 1024;
/** Max size of the old/new snippets in a patch. */
const MAX_SNIPPET_BYTES = 256 * 1024;
const SNIFF_BYTES = 8 * 1024;

function err(code: string, message: string): ClientToolResult {
  return { status: "error", errorCode: code, output: { message } };
}

/** The existing target must be a plain regular file (never a symlink — writing
 *  through it would hit a file not shown in the approval prompt — nor a FIFO/
 *  device, which would block). Returns a refusal, or null when it's safe (incl.
 *  a non-existent create target). */
function refuseUnsafeTarget(resolved: string, path: string): ClientToolResult | null {
  try {
    const ls = lstatSync(resolved);
    if (ls.isSymbolicLink()) return err("denied_symlink", `${path} is a symlink and is not written through`);
    if (!ls.isFile()) return err("invalid_args", `${path} exists and is not a regular file`);
  } catch {
    /* does not exist → a create, which is fine */
  }
  return null;
}

/** Write atomically: to a temp file in the same directory, then rename over the
 *  target — so a mid-write failure (ENOSPC, I/O) leaves the original intact
 *  instead of a truncated file. When overwriting, the existing file's mode is
 *  carried over (a `0600` secret or an executable script keeps its bits rather
 *  than reverting to the process default). */
function atomicWrite(target: string, content: string): void {
  let existingMode: number | undefined;
  try {
    existingMode = statSync(target).mode;
  } catch {
    /* new file → default mode */
  }
  const tmp = `${target}.lasso-${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, content, "utf-8");
    if (existingMode !== undefined) {
      try {
        chmodSync(tmp, existingMode);
      } catch {
        /* best-effort mode preservation */
      }
    }
    renameSync(tmp, target);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* temp may not exist */
    }
    throw e;
  }
}

function isBinary(resolved: string, size: number): boolean {
  const fd = openSync(resolved, "r");
  try {
    const buf = Buffer.alloc(Math.min(SNIFF_BYTES, size));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

// ── applyEdit (faithful port of dashboard workspace.ts) ──────────────────────

export type EditResult =
  | { ok: true; result: string; count: number }
  | { ok: false; error: string };

/** Replace `oldStr` with `newStr` in `content`. Exact-substring first (must be
 *  unique unless `replaceAll`); on no exact hit, a whitespace-insensitive
 *  line-block match. Pure — identical semantics to the backend patch tool. */
export function applyEdit(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean
): EditResult {
  if (!oldStr) return { ok: false, error: "old_string is empty" };
  if (oldStr === newStr) return { ok: false, error: "old_string and new_string are identical" };

  // 1. Exact substring match.
  const exact = content.split(oldStr).length - 1;
  if (exact === 1 || (exact > 1 && replaceAll)) {
    return {
      ok: true,
      result: replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr),
      count: replaceAll ? exact : 1,
    };
  }
  if (exact > 1 && !replaceAll) {
    return { ok: false, error: `old_string appears ${exact} times — add more surrounding context or set replace_all` };
  }

  // 2. Whitespace-insensitive line-block match (exact === 0).
  const cl = content.split("\n");
  const ol = oldStr.replace(/\n$/, "").split("\n");
  const trim = (s: string) => s.trim();
  const starts: number[] = [];
  for (let i = 0; i + ol.length <= cl.length; i++) {
    let hit = true;
    for (let j = 0; j < ol.length; j++) {
      if (trim(cl[i + j]) !== trim(ol[j])) {
        hit = false;
        break;
      }
    }
    if (hit) starts.push(i);
  }
  if (starts.length === 0) {
    return { ok: false, error: "old_string not found (tried exact and whitespace-insensitive matching)" };
  }
  // Keep only NON-OVERLAPPING matches (greedy, left-to-right): overlapping block
  // matches (e.g. `a\na\na` vs `a\na`) would corrupt the splice. NOTE: the
  // backend port doesn't filter yet — realign via the shared fixture (COW-2473).
  const nonOverlap: number[] = [];
  let lastEnd = -1;
  for (const st of starts) {
    if (st > lastEnd) {
      nonOverlap.push(st);
      lastEnd = st + ol.length - 1;
    }
  }
  if (nonOverlap.length > 1 && !replaceAll) {
    return { ok: false, error: `old_string matches ${nonOverlap.length} places — add more context or set replace_all` };
  }
  const nl = newStr.split("\n");
  const targets = replaceAll ? nonOverlap : [nonOverlap[0]];
  const out = cl.slice();
  // Splice from the last match backwards so earlier indices stay valid.
  for (const m of targets.slice().reverse()) {
    out.splice(m, ol.length, ...nl);
  }
  return { ok: true, result: out.join("\n"), count: targets.length };
}

// ── local_write_file ─────────────────────────────────────────────────────────

export interface WriteFileArgs {
  path: string;
  content: string;
}

function validateWriteArgs(args: unknown): asserts args is WriteFileArgs {
  if (!args || typeof args !== "object") throw new Error("write: args must be an object");
  const a = args as Record<string, unknown>;
  if (typeof a.path !== "string" || a.path.length === 0 || a.path.includes("\0")) {
    throw new Error("write: path is required");
  }
  if (typeof a.content !== "string") throw new Error("write: content must be a string");
  if (Buffer.byteLength(a.content, "utf8") > MAX_WRITE_BYTES) {
    throw new Error(`write: content exceeds ${MAX_WRITE_BYTES} bytes`);
  }
}

export function makeWriteFileTool(root: string = process.cwd()): LocalTool {
  return {
    name: WRITE_FILE_TOOL_NAME,
    permission: "write",
    validate: validateWriteArgs,
    run: async (args: unknown): Promise<ClientToolResult> => {
      const { path, content } = args as WriteFileArgs;
      const cls = classifyWritePath(path, root);
      // Defense-in-depth (the gate already denies these): an escaping target is
      // never valid, and agent writes are confined to the project — outside is
      // refused rather than followed through a possibly-symlinked external path.
      if (cls.scope === "invalid") return err("denied_invalid", "path escapes the project directory");
      if (cls.scope === "outside") return err("denied_outside", "writes are confined to the project directory");
      const unsafe = refuseUnsafeTarget(cls.resolved, path);
      if (unsafe) return unsafe;
      try {
        mkdirSync(dirname(cls.resolved), { recursive: true });
        atomicWrite(cls.resolved, content);
      } catch (e) {
        return err("write_failed", `could not write ${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return {
        status: "ok",
        output: { path, scope: cls.scope, bytes: Buffer.byteLength(content, "utf8") },
      };
    },
  };
}

// ── local_patch_file ─────────────────────────────────────────────────────────

export interface PatchFileArgs {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

function validatePatchArgs(args: unknown): asserts args is PatchFileArgs {
  if (!args || typeof args !== "object") throw new Error("patch: args must be an object");
  const a = args as Record<string, unknown>;
  if (typeof a.path !== "string" || a.path.length === 0 || a.path.includes("\0")) {
    throw new Error("patch: path is required");
  }
  if (typeof a.old_string !== "string" || a.old_string.length === 0) {
    throw new Error("patch: old_string is required");
  }
  if (typeof a.new_string !== "string") throw new Error("patch: new_string must be a string");
  for (const key of ["old_string", "new_string"] as const) {
    if (Buffer.byteLength(a[key] as string, "utf8") > MAX_SNIPPET_BYTES) {
      throw new Error(`patch: ${key} exceeds ${MAX_SNIPPET_BYTES} bytes`);
    }
  }
  if (a.replace_all !== undefined && typeof a.replace_all !== "boolean") {
    throw new Error("patch: replace_all must be a boolean");
  }
}

export function makePatchFileTool(root: string = process.cwd()): LocalTool {
  return {
    name: PATCH_FILE_TOOL_NAME,
    permission: "write",
    validate: validatePatchArgs,
    run: async (args: unknown): Promise<ClientToolResult> => {
      const { path, old_string, new_string, replace_all = false } = args as PatchFileArgs;
      const cls = classifyWritePath(path, root);
      if (cls.scope === "invalid") return err("denied_invalid", "path escapes the project directory");
      if (cls.scope === "outside") return err("denied_outside", "writes are confined to the project directory");
      const unsafe = refuseUnsafeTarget(cls.resolved, path);
      if (unsafe) return unsafe;

      let st;
      try {
        st = statSync(cls.resolved);
      } catch {
        return err("not_found", `no such file: ${path}`);
      }
      if (!st.isFile()) return err("invalid_args", `${path} is not a regular file`);
      if (st.size > MAX_PATCH_FILE_BYTES) return err("too_large", `file is ${st.size} bytes (max ${MAX_PATCH_FILE_BYTES})`);

      let content: string;
      try {
        if (st.size > 0 && isBinary(cls.resolved, st.size)) {
          return err("binary_file", `${path} looks binary — not patchable as text`);
        }
        content = readFileSync(cls.resolved, "utf-8");
      } catch {
        return err("unreadable", `could not read ${path}`);
      }

      const edit = applyEdit(content, old_string, new_string, replace_all);
      if (!edit.ok) {
        return err("no_edit", edit.error);
      }
      if (Buffer.byteLength(edit.result, "utf8") > MAX_WRITE_BYTES) {
        return err("too_large", `patched file would exceed ${MAX_WRITE_BYTES} bytes`);
      }
      try {
        atomicWrite(cls.resolved, edit.result);
      } catch (e) {
        return err("write_failed", `could not write ${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return { status: "ok", output: { path, scope: cls.scope, replaced: edit.count } };
    },
  };
}
