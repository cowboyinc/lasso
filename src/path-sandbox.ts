/**
 * Write path sandbox (COW-2464).
 *
 * The AI agent supplies the relative path a generated actor is written to
 * (`actor.filePath`), so that path is untrusted. This module classifies a write
 * target against the project root so the approval gate can confine writes:
 *
 *   - `inside`    — a normal in-project path, symlink-safe. Eligible for the
 *                   `auto`-mode auto-approval.
 *   - `protected` — an in-project path that must never be written silently
 *                   (`.git/`, `.cowboy/`, keys, `.env`, lockfiles, …). Always
 *                   asks, even in auto — the agent must not clobber wallet /
 *                   config / VCS state without an explicit prompt.
 *   - `outside`   — a well-formed absolute path outside the project. Approvable,
 *                   but never auto (the prompt shows where it lands).
 *   - `invalid`   — a traversal / symlink escape / malformed path. Refused.
 *
 * SCOPE (do not overstate): this confines local file writes routed through the
 * approval gate. It is NOT general containment — reads still flow to the hosted
 * backend, a future `exec` can write anywhere a shell can, and any write not
 * routed through this module is out of scope. It is also NOT race-free: parents
 * are created with `mkdirSync` and the write is not `O_NOFOLLOW`/atomic, so a
 * symlink planted between classification and write is not defended here — see
 * the TOCTOU follow-up. It blocks the pre-existing-symlink and traversal vectors.
 */

import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export type WriteScope = "inside" | "protected" | "outside" | "invalid";

export interface WriteClassification {
  scope: WriteScope;
  /** Absolute lexical target. Never write to it when `scope === "invalid"`. */
  resolved: string;
  /** The real path of the project root the target was classified against. */
  root: string;
}

/** Separator-aware containment: is `child` at or under `parent`? Guards against
 *  the `/repo2` vs `/repo` prefix trap that `startsWith` would miss. */
function isAtOrUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/** In-project paths that must never be written without an explicit prompt. */
const PROTECTED_DIRS = new Set([".git", ".cowboy", ".ssh", ".hg", ".svn"]);
const PROTECTED_BASENAME =
  /^(\.env.*|.*\.(key|pem|keystore|p12|pfx)|id_(rsa|ecdsa|ed25519).*|\.(bashrc|zshrc|profile|bash_profile|npmrc|netrc|pypirc)|package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock)$/i;

/** Is this ROOT-RELATIVE path protected? Exported for the local FS tools
 *  (COW-2458): reads/list/search must skip protected entries entirely — their
 *  contents (and even their names) would otherwise flow to the hosted backend. */
export function isProtectedRelative(rel: string): boolean {
  const segments = rel.split(sep).filter(Boolean);
  // A protected NAME anywhere in the path protects its descendants too, so a
  // child of `.env.d/`, `wallet.key/`, `.ssh/` … is protected as well — not
  // just the final segment. Case-insensitive (default macOS fs collapses case,
  // and a `.GIT` twin is deceptive regardless); PROTECTED_BASENAME carries /i.
  return segments.some(
    (s) => PROTECTED_DIRS.has(s.toLowerCase()) || PROTECTED_BASENAME.test(s)
  );
}

/**
 * Classify a backend-supplied write target against `root` (default: cwd).
 * Lexical containment is decided first, then the deepest existing ancestor is
 * realpath'd to catch a symlinked segment that redirects outside the root.
 */
export function classifyWritePath(
  filePath: string,
  root: string = process.cwd()
): WriteClassification {
  const realRoot = realpathSync(root);

  // Malformed input never reaches the filesystem.
  if (typeof filePath !== "string" || filePath.length === 0 || filePath.includes("\0")) {
    return { scope: "invalid", resolved: "", root: realRoot };
  }

  const absolute = isAbsolute(filePath);
  const lexical = absolute
    ? resolve(normalize(filePath))
    : resolve(realRoot, normalize(filePath));

  // Lexical containment first. A relative path that escaped via `..` is a
  // traversal attempt (invalid); a well-formed absolute path outside the root
  // is an explicit external target (outside, approvable).
  if (!isAtOrUnder(lexical, realRoot)) {
    return { scope: absolute ? "outside" : "invalid", resolved: lexical, root: realRoot };
  }

  // Inside lexically — canonicalize to catch a symlinked segment. Realpath the
  // deepest EXISTING ancestor, then re-attach the non-existent tail. This is the
  // path a write actually lands on, so both the containment AND protected checks
  // run against it — a symlink like `actors/main.py -> .env` must classify by
  // its real target (`.env`, protected), not its lexical name.
  // Walk with lstat, not stat: a DANGLING symlink "exists" as a link even
  // though its target doesn't — stat-based existence would skip past it to the
  // parent, classify the path `inside`, and the write would then FOLLOW the
  // link and create its target wherever it points (outside the sandbox).
  const lexists = (p: string): boolean => {
    try {
      lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };
  let existing = lexical;
  while (!lexists(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break; // reached the filesystem root
    existing = parent;
  }
  // realpath throws on a dangling symlink (no resolvable target). Writing
  // through it is never valid — fail closed.
  let realExisting: string;
  try {
    realExisting = realpathSync(existing);
  } catch {
    return { scope: "invalid", resolved: lexical, root: realRoot };
  }
  const tail = relative(existing, lexical); // "" when the target itself exists
  const realTarget = tail ? join(realExisting, tail) : realExisting;

  if (!isAtOrUnder(realTarget, realRoot)) {
    return { scope: "invalid", resolved: realTarget, root: realRoot };
  }
  // Protected by EITHER its real target OR its lexical name: a symlink named
  // `.env` (or `.ssh/config`) pointing at an innocuous-looking file must still
  // be treated as protected — otherwise a read/write through the protected
  // NAME would be allowed just because the link resolves elsewhere.
  if (
    isProtectedRelative(relative(realRoot, realTarget)) ||
    isProtectedRelative(relative(realRoot, lexical))
  ) {
    return { scope: "protected", resolved: realTarget, root: realRoot };
  }
  return { scope: "inside", resolved: realTarget, root: realRoot };
}
