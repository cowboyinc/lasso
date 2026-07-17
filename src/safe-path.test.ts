import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveSafeWritePath } from "./safe-path.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "lasso-safe-path-"));
}

test("a normal relative path resolves under the root", () => {
  const root = scratch();
  try {
    const p = resolveSafeWritePath("actors/counter/main.py", root);
    // The function anchors on the real path of the root (macOS tmp is a symlink).
    assert.equal(p, join(realpathSync(root), "actors/counter/main.py"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlinked directory component pointing outside the root is rejected (CWE-59)", () => {
  const root = scratch();
  const outside = scratch();
  try {
    // actors -> <outside>, so actors/foo/main.py would land in <outside>.
    symlinkSync(outside, join(root, "actors"));
    assert.throws(
      () => resolveSafeWritePath("actors/foo/main.py", root),
      /outside the project/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a symlinked target file pointing outside the root is rejected", () => {
  const root = scratch();
  const outside = scratch();
  try {
    mkdirSync(join(root, "actors"));
    writeFileSync(join(outside, "secret"), "x");
    symlinkSync(join(outside, "secret"), join(root, "actors", "main.py"));
    assert.throws(
      () => resolveSafeWritePath("actors/main.py", root),
      /outside the project/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("`..` traversal and absolute paths escape the root and are rejected", () => {
  const root = scratch();
  try {
    assert.throws(() => resolveSafeWritePath("../escape.py", root), /outside the project/);
    assert.throws(() => resolveSafeWritePath(resolve("/etc/passwd"), root), /outside the project/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
