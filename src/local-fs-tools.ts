/**
 * Local FS tools — read side (COW-2458, PR 1/2).
 *
 * The local analog of the backend's CBFS workspace tools, operating on the
 * project directory: `local_read_file`, `local_list`, `local_search`. The
 * write-side pair (`local_write_file`, `local_patch_file`) lands in PR 2/2.
 *
 * READS ARE THE EXFILTRATION SURFACE: everything these tools return flows to
 * the hosted backend, and the `read` permission class runs without a prompt.
 * So the confinement here is DENY, not ask:
 *   - only plain in-project targets are readable — `outside`, traversal and
 *     symlink escapes (`invalid`) are refused with structured errors;
 *   - `protected` paths (.env*, keys, .git/.cowboy internals, lockfiles, …)
 *     are refused for reads and skipped ENTIRELY by list/search, so neither
 *     their contents nor their names can leak into results;
 *   - every path is classified via the sandbox (canonicalized, symlink-safe)
 *     and the file is opened at the CANONICAL path the classifier returned,
 *     not the caller-supplied one.
 * Results are bounded: byte/line caps with explicit `truncated` flags so the
 * model can tell "capped" from "absent", clamped line lengths, entry caps,
 * fixed ignore set, no symlinked-directory traversal, binary files refused.
 */

import { lstatSync, openSync, readSync, closeSync, opendirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, normalize, relative, resolve, sep } from "node:path";
import { classifyWritePath, isProtectedRelative } from "./path-sandbox.js";
import type { ClientToolResult, LocalTool } from "./client-tool-bridge.js";

export const READ_FILE_TOOL_NAME = "local_read_file";
export const LIST_TOOL_NAME = "local_list";
export const SEARCH_TOOL_NAME = "local_search";

// ── Bounds ───────────────────────────────────────────────────────────────────

/** Max bytes of file content returned by a single read. */
export const MAX_READ_BYTES = 256 * 1024;
/** Default / max line window for a read. */
const DEFAULT_READ_LINES = 2_000;
const MAX_READ_LINES = 10_000;
/** Hard cap on the file size a read/search will even open. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
/** Listing caps. */
const MAX_LIST_ENTRIES = 500;
const DEFAULT_LIST_DEPTH = 4;
const MAX_LIST_DEPTH = 10;
/** Search caps. */
const MAX_SEARCH_RESULTS = 50;
const MAX_PATTERN_CHARS = 256;
/** Any line surfaced in results is clamped to this many chars. */
const LINE_CLAMP = 500;
/** Total files a single search will scan before stopping (belt-and-braces vs a
 *  huge project even under the per-dir cap). */
const MAX_SEARCH_FILES = 5_000;
/** Bytes sniffed for binary detection. */
const SNIFF_BYTES = 8 * 1024;

/** Directories never traversed by list/search (build output, VCS, deps). The
 *  sandbox's protected set is applied on top of this. */
const IGNORE_DIRS = new Set([
  ".git",
  ".cowboy",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".next",
  "target",
  "__pycache__",
  ".venv",
  "venv",
]);

// ── Shared helpers ───────────────────────────────────────────────────────────

function err(code: string, message: string): ClientToolResult {
  return { status: "error", errorCode: code, output: { message } };
}

/** Classify a read target. Returns the canonical absolute path to open, or a
 *  structured refusal. Deny, never ask: read results flow to the backend. */
function resolveReadTarget(
  path: unknown,
  root: string
): { ok: true; resolved: string; rel: string } | { ok: false; result: ClientToolResult } {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    return { ok: false, result: err("invalid_args", "path must be a non-empty string") };
  }
  const cls = classifyWritePath(path, root);
  if (cls.scope === "invalid") {
    return { ok: false, result: err("denied_outside", "path escapes the project directory") };
  }
  if (cls.scope === "outside") {
    return { ok: false, result: err("denied_outside", "reads are confined to the project directory") };
  }
  if (cls.scope === "protected") {
    return { ok: false, result: err("denied_protected", "this path is protected and cannot be read by the agent") };
  }
  // Otherwise in-project — but the read side never FOLLOWS a symlink, even one
  // that resolves back inside the project (the walk refuses symlinked children;
  // an explicit path must too). Reject any symlinked component in the chain.
  if (chainHasSymlink(path, root)) {
    return { ok: false, result: err("denied_symlink", "path traverses a symlink, which the read tools do not follow") };
  }
  return { ok: true, resolved: cls.resolved, rel: relative(cls.root, cls.resolved) };
}

/** Does the lexical path from the project root down to `path` cross a symlink at
 *  any component? (The read side canonicalizes for classification but must not
 *  actually follow links.) */
function chainHasSymlink(path: string, root: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  const lexical = resolve(realRoot, normalize(path));
  const rel = relative(realRoot, lexical);
  if (rel === "" || rel.startsWith("..")) return false; // not under root
  let cur = realRoot;
  for (const part of rel.split(sep).filter(Boolean)) {
    cur = join(cur, part);
    try {
      if (lstatSync(cur).isSymbolicLink()) return true;
    } catch {
      return false; // non-existent tail — nothing left to follow
    }
  }
  return false;
}

/** Any segment an ignored (build/VCS/deps) directory? Used to reject a list/
 *  search root that points INTO an ignored tree — walkProject only skips
 *  ignored dirs as it descends, not when one is the start. */
function isIgnoredRel(rel: string): boolean {
  return rel.split(sep).filter(Boolean).some((s) => IGNORE_DIRS.has(s.toLowerCase()));
}

/** NUL byte in the first chunk → binary. */
function sniffBinary(resolved: string, size: number): boolean {
  const fd = openSync(resolved, "r");
  try {
    const buf = Buffer.alloc(Math.min(SNIFF_BYTES, size));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

function clampLine(line: string): { text: string; clamped: boolean } {
  if (line.length <= LINE_CLAMP) return { text: line, clamped: false };
  return { text: line.slice(0, LINE_CLAMP), clamped: true };
}

/** Normalize a root-relative path to `/` separators so globs match the same
 *  way on every platform (walked entries use the OS separator). */
export function toPosixRel(rel: string): string {
  return sep === "/" ? rel : rel.split(sep).join("/");
}

type GlobTok = { t: "lit"; v: string } | { t: "star"; slash: boolean };

function tokenizeGlob(glob: string): GlobTok[] {
  const toks: GlobTok[] = [];
  for (let i = 0; i < glob.length; ) {
    if (glob[i] === "*") {
      let slash = false; // a run containing `**` may cross `/`
      while (glob[i] === "*") {
        if (glob[i + 1] === "*") {
          slash = true;
          i += 2;
        } else {
          i += 1;
        }
      }
      // `**/` means zero-or-more directories, so the trailing `/` is optional —
      // absorb it into the star so `**/main.py` still matches a root `main.py`.
      if (slash && glob[i] === "/") i += 1;
      const prev = toks[toks.length - 1];
      if (prev && prev.t === "star") prev.slash = prev.slash || slash;
      else toks.push({ t: "star", slash });
    } else {
      let v = "";
      while (i < glob.length && glob[i] !== "*") v += glob[i++];
      toks.push({ t: "lit", v });
    }
  }
  return toks;
}

/** Match a POSIX-style relative path against a glob (`*` = any run within a
 *  segment, `**` = any run across segments), LINEARLY. A two-pointer scan with a
 *  single backtrack-to-last-star is O(n·m) worst case — no catastrophic
 *  backtracking — so a pathological `*a*a*…` glob can't ReDoS the search. */
export function globMatch(glob: string, path: string): boolean {
  const toks = tokenizeGlob(glob);
  let ti = 0;
  let si = 0;
  let starTi = -1;
  let starSi = 0;
  let starSlash = false;
  while (si < path.length) {
    const tok = toks[ti];
    if (tok && tok.t === "lit") {
      if (path.startsWith(tok.v, si)) {
        si += tok.v.length;
        ti++;
        continue;
      }
    } else if (tok && tok.t === "star") {
      starTi = ti;
      starSi = si;
      starSlash = tok.slash;
      ti++;
      continue;
    }
    // mismatch (or ran out of tokens) → extend the most recent star by one char
    if (starTi >= 0) {
      if (!starSlash && path[starSi] === "/") return false; // `*` can't cross `/`
      starSi++;
      si = starSi;
      ti = starTi + 1;
      continue;
    }
    return false;
  }
  while (ti < toks.length && toks[ti].t === "star") ti++;
  return ti === toks.length;
}

interface WalkEntry {
  rel: string;
  type: "file" | "dir" | "symlink";
  size: number;
}

/** Entries read per directory before it's considered saturated (bounds a
 *  single pathological directory with millions of children). */
const MAX_DIR_ENTRIES = 4_000;
/** Total entries the (synchronous) walk examines before stopping — bounds a
 *  deep/wide tree so phase-1 traversal can't overrun the local-tool timeout
 *  before phase-2 yielding kicks in. */
const MAX_WALK_ENTRIES = 50_000;

/** Read up to `MAX_DIR_ENTRIES` names from a dir by STREAMING (opendir), so a
 *  huge directory never materializes/sorts in full before the caller's cap can
 *  fire. Returns the (sorted) bounded slice and whether entries were dropped. */
function readDirBounded(absDir: string): { names: string[]; capped: boolean } {
  let dir;
  try {
    dir = opendirSync(absDir);
  } catch {
    return { names: [], capped: false };
  }
  const names: string[] = [];
  let capped = false;
  try {
    for (let e = dir.readSync(); e !== null; e = dir.readSync()) {
      if (names.length >= MAX_DIR_ENTRIES) {
        capped = true; // more entries exist than we'll read
        break;
      }
      names.push(e.name);
    }
  } finally {
    dir.closeSync();
  }
  return { names: names.sort(), capped };
}

/** Bounded, symlink-safe project walk shared by list/search. Never follows a
 *  symlinked directory; never descends into ignored or protected dirs; never
 *  yields a protected entry. Depth-first, lexicographic, caps enforced by the
 *  caller via the return value of `visit`; a single directory is itself capped
 *  at MAX_DIR_ENTRIES so the walk can't be wedged by one giant folder. */
function walkProject(
  root: string,
  startRel: string,
  maxDepth: number,
  visit: (entry: WalkEntry) => boolean, // false = stop the walk
  signal?: AbortSignal
): { dirCapped: boolean; walkCapped: boolean; depthCapped: boolean } {
  let dirCapped = false;
  let walkCapped = false;
  let depthCapped = false;
  let examined = 0;
  const walk = (relDir: string, depth: number): boolean => {
    if (signal?.aborted) return false;
    const { names, capped } = readDirBounded(join(root, relDir));
    if (capped) dirCapped = true; // some entries in this dir were dropped
    for (const name of names) {
      if (signal?.aborted) return false;
      if (++examined > MAX_WALK_ENTRIES) {
        walkCapped = true; // bound the synchronous traversal itself
        return false;
      }
      const rel = relDir ? join(relDir, name) : name;
      if (isProtectedRelative(rel)) continue; // never surfaced, never entered
      let st;
      try {
        st = lstatSync(join(root, rel));
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        // Surfaced as a symlink but NEVER followed — a link into .ssh or out of
        // the project must not be traversable via list/search.
        if (!visit({ rel, type: "symlink", size: 0 })) return false;
        continue;
      }
      if (st.isDirectory()) {
        if (IGNORE_DIRS.has(name.toLowerCase())) continue;
        if (!visit({ rel, type: "dir", size: 0 })) return false;
        if (depth < maxDepth) {
          if (!walk(rel, depth + 1)) return false;
        } else {
          depthCapped = true; // subtree below the depth limit was not visited
        }
        continue;
      }
      if (st.isFile()) {
        if (!visit({ rel, type: "file", size: st.size })) return false;
      }
    }
    return true;
  };
  walk(startRel, 1);
  return { dirCapped, walkCapped, depthCapped };
}

// ── local_read_file ──────────────────────────────────────────────────────────

export interface ReadFileArgs {
  path: string;
  /** 1-based first line of the window (default 1). */
  offset?: number;
  /** Max lines returned (default 2000). */
  limit?: number;
}

function validateReadArgs(args: unknown): asserts args is ReadFileArgs {
  if (!args || typeof args !== "object") throw new Error("read: args must be an object");
  const a = args as Record<string, unknown>;
  if (typeof a.path !== "string" || a.path.length === 0) throw new Error("read: path is required");
  for (const key of ["offset", "limit"] as const) {
    const v = a[key];
    if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 10_000_000)) {
      throw new Error(`read: ${key} must be a positive integer`);
    }
  }
}

export function makeReadFileTool(root: string = process.cwd()): LocalTool {
  return {
    name: READ_FILE_TOOL_NAME,
    permission: "read",
    validate: validateReadArgs,
    run: async (args: unknown): Promise<ClientToolResult> => {
      const { path, offset = 1, limit = DEFAULT_READ_LINES } = args as ReadFileArgs;
      const target = resolveReadTarget(path, root);
      if (!target.ok) return target.result;

      let st;
      try {
        st = statSync(target.resolved);
      } catch {
        return err("not_found", `no such file: ${target.rel}`);
      }
      if (st.isDirectory()) return err("invalid_args", `${target.rel} is a directory — use ${LIST_TOOL_NAME}`);
      // FIFOs, sockets and devices are not regular files — reading a named pipe
      // would block the event loop indefinitely (past the dispatch timeout).
      if (!st.isFile()) return err("invalid_args", `${target.rel} is not a regular file`);
      if (st.size > MAX_FILE_BYTES) return err("too_large", `file is ${st.size} bytes (max ${MAX_FILE_BYTES})`);

      // Wrap the open/read: a permission error or a TOCTOU removal/replace after
      // statSync would otherwise escape as a generic tool_failed carrying Node's
      // raw message WITH the absolute path — a relative structured error instead.
      let text: string;
      try {
        if (st.size > 0 && sniffBinary(target.resolved, st.size)) {
          return err("binary_file", `${target.rel} looks binary (${st.size} bytes) — not readable as text`);
        }
        text = readFileSync(target.resolved, "utf-8");
      } catch {
        return err("unreadable", `could not read ${target.rel}`);
      }
      // An empty file has 0 lines (`"".split` would claim 1), and an offset
      // past EOF returns an EMPTY window — never re-serving the final line —
      // so an agent paging by increasing `offset` sees a clean end-of-file.
      const lines = text === "" ? [] : text.split("\n");
      const totalLines = lines.length;
      const from = offset;
      const window = from > totalLines ? [] : lines.slice(from - 1, from - 1 + Math.min(limit, MAX_READ_LINES));

      let anyLineClamped = false;
      const clamped = window.map((l) => {
        const c = clampLine(l);
        anyLineClamped = anyLineClamped || c.clamped;
        return c.text;
      });

      let content = clamped.join("\n");
      let truncated = anyLineClamped || from - 1 + window.length < totalLines;
      if (Buffer.byteLength(content, "utf8") > MAX_READ_BYTES) {
        // Trim whole lines from the end until under the byte cap.
        while (clamped.length > 0 && Buffer.byteLength(clamped.join("\n"), "utf8") > MAX_READ_BYTES) {
          clamped.pop();
        }
        content = clamped.join("\n");
        truncated = true;
      }

      return {
        status: "ok",
        output: {
          path: target.rel,
          content,
          offset: from,
          lines: clamped.length,
          totalLines,
          truncated,
        },
      };
    },
  };
}

// ── local_list ───────────────────────────────────────────────────────────────

export interface ListArgs {
  /** Directory to list, relative to the project root (default "."). */
  path?: string;
  maxDepth?: number;
}

function validateListArgs(args: unknown): asserts args is ListArgs {
  if (!args || typeof args !== "object") throw new Error("list: args must be an object");
  const a = args as Record<string, unknown>;
  if (a.path !== undefined && (typeof a.path !== "string" || a.path.length === 0)) {
    throw new Error("list: path must be a non-empty string when given");
  }
  if (
    a.maxDepth !== undefined &&
    (typeof a.maxDepth !== "number" || !Number.isInteger(a.maxDepth) || a.maxDepth < 1 || a.maxDepth > MAX_LIST_DEPTH)
  ) {
    throw new Error(`list: maxDepth must be an integer in [1, ${MAX_LIST_DEPTH}]`);
  }
}

export function makeListTool(root: string = process.cwd()): LocalTool {
  return {
    name: LIST_TOOL_NAME,
    permission: "read",
    validate: validateListArgs,
    run: async (args: unknown, signal?: AbortSignal): Promise<ClientToolResult> => {
      const { path = ".", maxDepth = DEFAULT_LIST_DEPTH } = args as ListArgs;
      const target = resolveReadTarget(path, root);
      if (!target.ok) return target.result; // includes a symlinked-directory root
      let st;
      try {
        st = statSync(target.resolved);
      } catch {
        return err("not_found", `no such directory: ${target.rel || "."}`);
      }
      if (!st.isDirectory()) return err("invalid_args", `${target.rel} is a file — use ${READ_FILE_TOOL_NAME}`);
      // A root pointing into an ignored tree (node_modules, dist, .git…) is
      // treated as empty — walkProject only skips ignored dirs while descending.
      if (isIgnoredRel(target.rel)) {
        return { status: "ok", output: { root: target.rel, entries: [], truncated: false, ignored: true } };
      }

      const entries: Array<{ path: string; type: string; size?: number }> = [];
      let truncated = false;
      const { dirCapped, walkCapped, depthCapped } = walkProject(
        root,
        target.rel,
        maxDepth,
        (e) => {
          if (entries.length >= MAX_LIST_ENTRIES) {
            truncated = true;
            return false;
          }
          entries.push({ path: e.rel, type: e.type, ...(e.type === "file" ? { size: e.size } : {}) });
          return true;
        },
        signal
      );
      return { status: "ok", output: { root: target.rel || ".", entries, truncated: truncated || dirCapped || walkCapped || depthCapped } };
    },
  };
}

// ── local_search ─────────────────────────────────────────────────────────────

export interface SearchArgs {
  /** Literal text to find (matched as a substring, not a regex). */
  pattern: string;
  /** Rejected if `true` — regex search is a follow-up (see validate). */
  regex?: boolean;
  /** Root-relative glob filter, e.g. `actors/**` or `*.py`. */
  glob?: string;
  maxResults?: number;
  caseSensitive?: boolean;
}

function validateSearchArgs(args: unknown): asserts args is SearchArgs {
  if (!args || typeof args !== "object") throw new Error("search: args must be an object");
  const a = args as Record<string, unknown>;
  if (typeof a.pattern !== "string" || a.pattern.length === 0 || a.pattern.length > MAX_PATTERN_CHARS) {
    throw new Error(`search: pattern must be a string of 1..${MAX_PATTERN_CHARS} chars`);
  }
  if (a.caseSensitive !== undefined && typeof a.caseSensitive !== "boolean") {
    throw new Error("search: caseSensitive must be a boolean");
  }
  // Regex search is intentionally not supported in v1: a backend-supplied
  // pattern can trigger catastrophic backtracking that hangs the (synchronous)
  // scan, and no heuristic reliably detects every ReDoS. `pattern` is matched
  // LITERALLY. A safe regex mode (linear engine / worker with a hard timeout)
  // is a follow-up. Reject `regex: true` loudly so the model doesn't assume it.
  if (a.regex === true) {
    throw new Error("search: regex mode is not supported yet — `pattern` is matched literally; omit `regex`");
  }
  if (a.glob !== undefined && (typeof a.glob !== "string" || a.glob.length === 0 || a.glob.length > 256)) {
    throw new Error("search: glob must be a short string when given");
  }
  if (
    a.maxResults !== undefined &&
    (typeof a.maxResults !== "number" ||
      !Number.isInteger(a.maxResults) ||
      a.maxResults < 1 ||
      a.maxResults > MAX_SEARCH_RESULTS)
  ) {
    throw new Error(`search: maxResults must be an integer in [1, ${MAX_SEARCH_RESULTS}]`);
  }
}

export function makeSearchTool(root: string = process.cwd()): LocalTool {
  return {
    name: SEARCH_TOOL_NAME,
    permission: "read",
    validate: validateSearchArgs,
    run: async (args: unknown, signal?: AbortSignal): Promise<ClientToolResult> => {
      const { pattern, glob, maxResults = MAX_SEARCH_RESULTS, caseSensitive = false } = args as SearchArgs;

      // LITERAL full-line substring match — linear, no backtracking, so the whole
      // line is scanned (a hit past any offset is still found) and there is no
      // ReDoS surface. Regex search is a follow-up (needs a linear engine).
      const needle = caseSensitive ? pattern : pattern.toLowerCase();
      const lineMatches = (line: string): boolean =>
        (caseSensitive ? line : line.toLowerCase()).includes(needle);

      // Phase 1: collect candidate files (metadata only — bounded, cheap). The
      // expensive read+match work is deferred to phase 2 so it can yield.
      const candidates: Array<{ rel: string; size: number }> = [];
      let scanLimitHit = false;
      let skippedLarge = false;
      const { dirCapped, walkCapped, depthCapped } = walkProject(
        root,
        "",
        MAX_LIST_DEPTH,
        (e) => {
          if (e.type !== "file") return true;
          // Apply the glob first: a large file that doesn't match the glob is
          // simply out of scope, not an omitted candidate.
          if (glob && !globMatch(glob, toPosixRel(e.rel))) return true;
          if (e.size > MAX_SEARCH_FILE_BYTES) {
            skippedLarge = true; // matches in this in-scope file may be omitted
            return true;
          }
          if (candidates.length >= MAX_SEARCH_FILES) {
            scanLimitHit = true;
            return false;
          }
          candidates.push({ rel: e.rel, size: e.size });
          return true;
        },
        signal
      );

      // Phase 2: scan contents, yielding to the event loop every few files so
      // the dispatch timeout AND Ctrl-C abort can actually fire mid-scan (they
      // run as macrotasks that a long synchronous loop would otherwise starve).
      const matches: Array<{ path: string; line: number; text: string; clamped?: boolean }> = [];
      let truncatedResults = false;
      let filesScanned = 0;
      let aborted = false;
      for (let f = 0; f < candidates.length; f++) {
        if ((f & 15) === 0) await new Promise((r) => setImmediate(r));
        if (signal?.aborted) {
          aborted = true;
          break;
        }
        const { rel, size } = candidates[f];
        const abs = join(root, rel);
        try {
          if (size > 0 && sniffBinary(abs, size)) continue;
          filesScanned++;
          const lines = readFileSync(abs, "utf-8").split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lineMatches(lines[i])) {
              if (matches.length >= maxResults) {
                truncatedResults = true;
                break;
              }
              const c = clampLine(lines[i]);
              matches.push({ path: rel, line: i + 1, text: c.text, ...(c.clamped ? { clamped: true } : {}) });
            }
          }
        } catch {
          /* unreadable file — skip */
        }
        if (truncatedResults) break;
      }

      return {
        status: "ok",
        output: {
          pattern,
          matches,
          filesScanned,
          truncatedResults,
          truncatedScan: scanLimitHit || dirCapped || walkCapped || depthCapped || skippedLarge || aborted,
        },
      };
    },
  };
}
