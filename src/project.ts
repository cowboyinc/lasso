/**
 * Project workspace resolution (COW-2459).
 *
 * lasso's workspace is the project it runs in: the nearest ancestor directory
 * that holds a `.cowboy/` directory (like git finding `.git/`). Resolving the
 * root by walking UP from the launch directory means the console — and every
 * project-scoped thing keyed off it (config, the path sandbox, the local FS
 * tools, where generated actors land) — works the same whether you start lasso
 * at the project root or in a subdirectory.
 *
 * The entry point (`cli.tsx`) resolves the root once and `chdir`s into it, so
 * the rest of the code can keep using `process.cwd()` as the single source of
 * truth for the workspace root.
 */

import { statSync } from "node:fs";
import { dirname, join } from "node:path";

function hasCowboyDir(dir: string): boolean {
  try {
    return statSync(join(dir, ".cowboy")).isDirectory();
  } catch {
    return false;
  }
}

export interface ProjectRoot {
  /** The resolved workspace root — the project root when found, else `start`. */
  root: string;
  /** Whether a `.cowboy/` project directory was found at/above `start`. */
  found: boolean;
}

/**
 * Walk up from `start` (default: cwd) to the nearest ancestor containing a
 * `.cowboy/` directory. Returns that directory when found; otherwise `start`
 * with `found: false` (a fresh directory where `/init` can create a project).
 */
export function findProjectRoot(start: string = process.cwd()): ProjectRoot {
  let dir = start;
  while (true) {
    if (hasCowboyDir(dir)) return { root: dir, found: true };
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return { root: start, found: false };
}
