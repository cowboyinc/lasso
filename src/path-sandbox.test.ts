import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { classifyWritePath } from "./path-sandbox.js";

function scratch(): string {
  // realpath so comparisons hold on macOS, where /tmp and /var are symlinks.
  return realpathSync(mkdtempSync(join(tmpdir(), "lasso-sandbox-")));
}

test("a normal relative path is `inside` and resolves under the root", () => {
  const root = scratch();
  try {
    const c = classifyWritePath("actors/counter/main.py", root);
    assert.equal(c.scope, "inside");
    assert.equal(c.resolved, join(root, "actors/counter/main.py"));
    assert.equal(c.root, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`..` traversal is `invalid` (blocked), not `outside`", () => {
  const root = scratch();
  try {
    assert.equal(classifyWritePath("../escape.py", root).scope, "invalid");
    assert.equal(classifyWritePath("actors/../../escape.py", root).scope, "invalid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a well-formed absolute path outside the root is `outside` (approvable, never auto)", () => {
  const root = scratch();
  const other = scratch();
  try {
    assert.equal(classifyWritePath(join(other, "x.py"), root).scope, "outside");
    assert.equal(classifyWritePath(resolve("/etc/passwd"), root).scope, "outside");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("containment is separator-aware: a sibling like `<root>-evil` is not inside", () => {
  const root = scratch();
  const sibling = `${root}-evil`;
  mkdirSync(sibling, { recursive: true });
  try {
    assert.equal(classifyWritePath(join(sibling, "x.py"), root).scope, "outside");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(sibling, { recursive: true, force: true });
  }
});

test("a symlinked directory component escaping the root is `invalid` (CWE-59)", () => {
  const root = scratch();
  const outside = scratch();
  try {
    symlinkSync(outside, join(root, "actors")); // actors -> <outside>
    assert.equal(classifyWritePath("actors/foo/main.py", root).scope, "invalid");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a symlinked target file escaping the root is `invalid`", () => {
  const root = scratch();
  const outside = scratch();
  try {
    mkdirSync(join(root, "actors"));
    writeFileSync(join(outside, "secret"), "x");
    symlinkSync(join(outside, "secret"), join(root, "actors", "main.py"));
    assert.equal(classifyWritePath("actors/main.py", root).scope, "invalid");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("an in-project symlink whose REAL target is protected classifies as `protected`", () => {
  // The escalation codex flagged: actors/main.py -> .env resolves inside the
  // root, so it isn't `invalid`, but must not be treated as a plain `inside`
  // write (which auto-mode would auto-approve straight into .env).
  const root = scratch();
  try {
    writeFileSync(join(root, ".env"), "SECRET=1");
    mkdirSync(join(root, "actors"));
    symlinkSync(join(root, ".env"), join(root, "actors", "main.py"));
    assert.equal(classifyWritePath("actors/main.py", root).scope, "protected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a directory symlink into a protected dir classifies its children as `protected`", () => {
  // actors/ -> .cowboy/ ; actors/x.json really lands in .cowboy/x.json.
  const root = scratch();
  try {
    mkdirSync(join(root, ".cowboy"));
    symlinkSync(join(root, ".cowboy"), join(root, "actors"));
    assert.equal(classifyWritePath("actors/x.json", root).scope, "protected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("protected in-project paths classify as `protected` (never silently written)", () => {
  const root = scratch();
  try {
    for (const p of [
      ".git/hooks/pre-commit",
      ".cowboy/config.json",
      "deep/nested/.git/config",
      "secrets/id_ed25519",
      "wallet.key",
      "server.pem",
      ".env",
      ".env.local",
      "bun.lockb",
      "package-lock.json",
    ]) {
      assert.equal(classifyWritePath(p, root).scope, "protected", p);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a plain in-project actor file is NOT protected", () => {
  const root = scratch();
  try {
    assert.equal(classifyWritePath("actors/env-reader/main.py", root).scope, "inside");
    assert.equal(classifyWritePath("src/index.ts", root).scope, "inside");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed input (empty, NUL byte) is `invalid`", () => {
  const root = scratch();
  try {
    assert.equal(classifyWritePath("", root).scope, "invalid");
    assert.equal(classifyWritePath("a\0b.py", root).scope, "invalid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("protected dirs match case-insensitively (.GIT is .git on macOS)", () => {
  const root = scratch();
  try {
    assert.equal(classifyWritePath(".GIT/config", root).scope, "protected");
    assert.equal(classifyWritePath("nested/.Cowboy/state.json", root).scope, "protected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a DANGLING symlink target is invalid — the write would create the link's target", () => {
  const root = scratch();
  try {
    mkdirSync(join(root, "actors"));
    // Target file is a dangling symlink pointing outside the project.
    symlinkSync("/tmp/lasso-pwned-nonexistent", join(root, "actors", "main.py"));
    assert.equal(classifyWritePath("actors/main.py", root).scope, "invalid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dangling DIRECTORY symlink component is invalid", () => {
  const root = scratch();
  try {
    symlinkSync("/tmp/lasso-nonexistent-dir", join(root, "actors")); // dangling dir link
    assert.equal(classifyWritePath("actors/foo/main.py", root).scope, "invalid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
