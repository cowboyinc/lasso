/**
 * Symlink-safe resolution for backend-controlled write targets (COW-2463).
 *
 * The AI agent supplies the relative path a generated actor is written to
 * (`actor.filePath`). That path is untrusted: a malicious repo can plant a
 * symlink (e.g. `actors/` → `~/.ssh`) so a naive `join(cwd, filePath)` +
 * `writeFileSync` would follow it and clobber a file outside the project
 * (CWE-59). Resolve the target and verify its deepest EXISTING ancestor's real
 * path stays inside the project root before any write.
 *
 * NOTE: this closes the pre-existing-symlink vector. A fully TOCTOU-safe write
 * (O_NOFOLLOW on every component, atomic rename) belongs to the FS sandbox
 * (COW-2464); the non-existent tail created by `mkdirSync` can't be a symlink
 * because those components don't exist yet.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, normalize, resolve, sep } from "node:path";

/**
 * Resolve `filePath` under `root` (default: cwd) to an absolute path, throwing
 * if it escapes the root — via `..`, an absolute path, or a symlinked directory
 * component. Returns the absolute target on success.
 */
export function resolveSafeWritePath(filePath: string, root: string = process.cwd()): string {
  const realRoot = realpathSync(root);
  // `resolve` lets an absolute `filePath` override root; the ancestor check
  // below still catches that (its real path won't be under realRoot).
  const target = resolve(realRoot, normalize(filePath));

  // The target usually doesn't exist yet — walk up to the nearest existing
  // ancestor and realpath THAT, so a symlinked segment can't redirect the write.
  let existing = target;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break; // reached the filesystem root
    existing = parent;
  }
  const realExisting = realpathSync(existing);

  if (realExisting !== realRoot && !realExisting.startsWith(realRoot + sep)) {
    throw new Error(`refusing to write outside the project directory: ${filePath}`);
  }
  return target;
}
