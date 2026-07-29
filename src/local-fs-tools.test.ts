import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeReadFileTool,
  makeListTool,
  makeSearchTool,
  globMatch,
  MAX_READ_BYTES,
} from "./local-fs-tools.js";
import type { ClientToolResult } from "./client-tool-bridge.js";

function scratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "lasso-fs-")));
}

function errCode(res: ClientToolResult): string | undefined {
  return res.status === "error" ? res.errorCode : undefined;
}

function okOutput(res: ClientToolResult): Record<string, unknown> {
  assert.equal(res.status, "ok", `expected ok, got ${JSON.stringify(res)}`);
  return (res as { status: "ok"; output: unknown }).output as Record<string, unknown>;
}

// ── read: happy paths ────────────────────────────────────────────────────────

test("read: returns content with line accounting", async () => {
  const root = scratch();
  try {
    mkdirSync(join(root, "actors"));
    writeFileSync(join(root, "actors", "main.py"), "line1\nline2\nline3");
    const res = await makeReadFileTool(root).run({ path: "actors/main.py" });
    const out = okOutput(res);
    assert.equal(out.content, "line1\nline2\nline3");
    assert.equal(out.totalLines, 3);
    assert.equal(out.truncated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read: offset/limit window lines and flag truncation", async () => {
  const root = scratch();
  try {
    writeFileSync(join(root, "big.txt"), Array.from({ length: 100 }, (_, i) => `L${i + 1}`).join("\n"));
    const res = await makeReadFileTool(root).run({ path: "big.txt", offset: 10, limit: 5 });
    const out = okOutput(res);
    assert.equal(out.content, "L10\nL11\nL12\nL13\nL14");
    assert.equal(out.offset, 10);
    assert.equal(out.lines, 5);
    assert.equal(out.truncated, true, "window smaller than the file must flag truncation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read: byte cap trims whole lines and flags truncation", async () => {
  const root = scratch();
  try {
    const line = "x".repeat(400);
    writeFileSync(join(root, "big.txt"), Array.from({ length: 1000 }, () => line).join("\n"));
    const res = await makeReadFileTool(root).run({ path: "big.txt" });
    const out = okOutput(res);
    assert.ok(Buffer.byteLength(out.content as string, "utf8") <= MAX_READ_BYTES);
    assert.equal(out.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read: offset past EOF returns an empty window; empty files report 0 lines", async () => {
  const root = scratch();
  try {
    writeFileSync(join(root, "three.txt"), "a\nb\nc");
    const past = okOutput(await makeReadFileTool(root).run({ path: "three.txt", offset: 10 }));
    assert.equal(past.content, "");
    assert.equal(past.lines, 0);
    assert.equal(past.truncated, false, "an empty past-EOF window is a clean end, not truncation");

    writeFileSync(join(root, "empty.txt"), "");
    const empty = okOutput(await makeReadFileTool(root).run({ path: "empty.txt" }));
    assert.equal(empty.totalLines, 0);
    assert.equal(empty.content, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── read: confinement (deny, never ask) ─────────────────────────────────────

test("read: protected paths are denied (exfiltration guard)", async () => {
  const root = scratch();
  try {
    writeFileSync(join(root, ".env"), "SECRET=1");
    mkdirSync(join(root, ".cowboy"));
    writeFileSync(join(root, ".cowboy", "config.json"), "{}");
    for (const p of [".env", ".cowboy/config.json", "wallet.key"]) {
      const res = await makeReadFileTool(root).run({ path: p });
      assert.equal(errCode(res), "denied_protected", p);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read: outside / traversal / symlink-escape are denied", async () => {
  const root = scratch();
  const outside = scratch();
  try {
    writeFileSync(join(outside, "secret.txt"), "top secret");
    // absolute outside
    assert.equal(errCode(await makeReadFileTool(root).run({ path: join(outside, "secret.txt") })), "denied_outside");
    // traversal
    assert.equal(errCode(await makeReadFileTool(root).run({ path: "../secret.txt" })), "denied_outside");
    // in-project symlink pointing out
    symlinkSync(join(outside, "secret.txt"), join(root, "innocent.txt"));
    assert.equal(errCode(await makeReadFileTool(root).run({ path: "innocent.txt" })), "denied_outside");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("read: an in-project symlink to a protected file is denied as protected", async () => {
  const root = scratch();
  try {
    writeFileSync(join(root, ".env"), "SECRET=1");
    symlinkSync(join(root, ".env"), join(root, "notes.txt"));
    assert.equal(errCode(await makeReadFileTool(root).run({ path: "notes.txt" })), "denied_protected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read: .envrc / .netrc / .pfx variants are protected too", async () => {
  const root = scratch();
  try {
    for (const p of [".envrc", ".env.production", ".netrc", "cert.pfx", "bun.lock", "bun.lockb"]) {
      writeFileSync(join(root, p), "secret");
      assert.equal(errCode(await makeReadFileTool(root).run({ path: p })), "denied_protected", p);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read: a symlink NAMED like a protected file is denied by its name", async () => {
  // `.env` -> innocuous config/dev: the real target isn't protected, but the
  // protected NAME must still block the read (no exfil via a deceptive link).
  const root = scratch();
  try {
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config", "dev"), "harmless");
    symlinkSync(join(root, "config", "dev"), join(root, ".env"));
    assert.equal(errCode(await makeReadFileTool(root).run({ path: ".env" })), "denied_protected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read: a path through an intermediate symlinked directory is not followed", async () => {
  // linked -> src (both in-project): reading linked/foo.ts must be refused, not
  // silently resolved to src/foo.ts.
  const root = scratch();
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "foo.ts"), "x");
    symlinkSync(join(root, "src"), join(root, "linked"));
    assert.equal(errCode(await makeReadFileTool(root).run({ path: "linked/foo.ts" })), "denied_symlink");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read: a child of a protected-named directory is protected too", async () => {
  const root = scratch();
  try {
    mkdirSync(join(root, ".env.d"));
    writeFileSync(join(root, ".env.d", "secrets.json"), "{}");
    assert.equal(errCode(await makeReadFileTool(root).run({ path: ".env.d/secrets.json" })), "denied_protected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read: binary files are refused; missing files are not_found", async () => {
  const root = scratch();
  try {
    writeFileSync(join(root, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d, 0x0a]));
    assert.equal(errCode(await makeReadFileTool(root).run({ path: "blob.bin" })), "binary_file");
    assert.equal(errCode(await makeReadFileTool(root).run({ path: "nope.txt" })), "not_found");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── list ─────────────────────────────────────────────────────────────────────

test("list: skips protected and ignored dirs entirely (names never leak)", async () => {
  const root = scratch();
  try {
    mkdirSync(join(root, "actors"));
    writeFileSync(join(root, "actors", "main.py"), "x");
    writeFileSync(join(root, ".env"), "SECRET=1");
    writeFileSync(join(root, ".env.local"), "SECRET=2");
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "ref");
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "x");

    const out = okOutput(await makeListTool(root).run({}));
    const paths = (out.entries as Array<{ path: string }>).map((e) => e.path);
    assert.ok(paths.includes("actors"), "actors dir listed");
    assert.ok(paths.includes(join("actors", "main.py")), "actor file listed");
    for (const leaked of [".env", ".env.local", ".git", join(".git", "HEAD"), "node_modules"]) {
      assert.ok(!paths.some((p) => p === leaked || p.startsWith(leaked + "/")), `${leaked} must not appear`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("list: symlinked directories are reported but never followed", async () => {
  const root = scratch();
  const outside = scratch();
  try {
    mkdirSync(join(outside, "loot"));
    writeFileSync(join(outside, "loot", "keys.txt"), "x");
    symlinkSync(join(outside, "loot"), join(root, "linked"));
    const out = okOutput(await makeListTool(root).run({}));
    const entries = out.entries as Array<{ path: string; type: string }>;
    const link = entries.find((e) => e.path === "linked");
    assert.equal(link?.type, "symlink");
    assert.ok(!entries.some((e) => e.path.includes("keys.txt")), "must not traverse through the link");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("list: a symlinked-directory root is not followed", async () => {
  const root = scratch();
  try {
    mkdirSync(join(root, "actual"));
    writeFileSync(join(root, "actual", "secret.txt"), "x");
    symlinkSync(join(root, "actual"), join(root, "linked"));
    const res = await makeListTool(root).run({ path: "linked" });
    assert.equal(errCode(res), "denied_symlink");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("list: entry cap flags truncation", async () => {
  const root = scratch();
  try {
    for (let i = 0; i < 600; i++) writeFileSync(join(root, `f${String(i).padStart(3, "0")}.txt`), "x");
    const out = okOutput(await makeListTool(root).run({}));
    assert.equal((out.entries as unknown[]).length, 500);
    assert.equal(out.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── search ───────────────────────────────────────────────────────────────────

test("search: literal by default, finds matches with line numbers", async () => {
  const root = scratch();
  try {
    mkdirSync(join(root, "actors"));
    writeFileSync(join(root, "actors", "a.py"), "import json\nx = a+b\n");
    writeFileSync(join(root, "readme.md"), "nothing here");
    const out = okOutput(await makeSearchTool(root).run({ pattern: "a+b" }));
    const matches = out.matches as Array<{ path: string; line: number; text: string }>;
    assert.equal(matches.length, 1, "a+b must be literal, not regex");
    assert.equal(matches[0].path, join("actors", "a.py"));
    assert.equal(matches[0].line, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("search: glob filter + result cap flag (literal)", async () => {
  const root = scratch();
  try {
    mkdirSync(join(root, "src"));
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(root, "src", `m${i}.ts`), "match_here\nmatch_here\n");
    }
    writeFileSync(join(root, "other.py"), "match_here\n");
    const out = okOutput(
      await makeSearchTool(root).run({ pattern: "match_here", glob: "src/**", maxResults: 5 })
    );
    const matches = out.matches as Array<{ path: string }>;
    assert.equal(matches.length, 5);
    assert.equal(out.truncatedResults, true);
    assert.ok(matches.every((m) => m.path.startsWith("src/")), "glob filter applies");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("search: never matches inside protected files", async () => {
  const root = scratch();
  try {
    writeFileSync(join(root, ".env"), "API_TOKEN=supersecret\n");
    writeFileSync(join(root, "app.py"), "token = load()\n");
    const out = okOutput(await makeSearchTool(root).run({ pattern: "supersecret" }));
    assert.equal((out.matches as unknown[]).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("search: long lines are clamped and flagged", async () => {
  const root = scratch();
  try {
    writeFileSync(join(root, "min.js"), "needle" + "x".repeat(5000) + "\n");
    const out = okOutput(await makeSearchTool(root).run({ pattern: "needle" }));
    const m = (out.matches as Array<{ text: string; clamped?: boolean }>)[0];
    assert.equal(m.text.length, 500);
    assert.equal(m.clamped, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("search: an aborted signal stops the walk (partial results)", async () => {
  const root = scratch();
  try {
    writeFileSync(join(root, "a.txt"), "needle\n");
    const out = okOutput(await makeSearchTool(root).run({ pattern: "needle" }, AbortSignal.abort()));
    assert.equal((out.matches as unknown[]).length, 0, "aborted before scanning");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── validation + glob unit ───────────────────────────────────────────────────

test("validation rejects malformed args", async () => {
  const root = scratch();
  try {
    assert.throws(() => makeReadFileTool(root).validate({ path: "" }));
    assert.throws(() => makeReadFileTool(root).validate({ path: "a", offset: 0 }));
    assert.throws(() => makeListTool(root).validate({ maxDepth: 99 }));
    assert.throws(() => makeSearchTool(root).validate({ pattern: "" }));
    assert.throws(() => makeSearchTool(root).validate({ pattern: "x", maxResults: 999 }));
    assert.throws(() => makeSearchTool(root).validate({ pattern: "x", caseSensitive: "false" }));
    // Regex mode is not supported in v1 — reject it loudly (no ReDoS surface).
    assert.throws(() => makeSearchTool(root).validate({ pattern: "a.*b", regex: true }), /not supported/);
    // A pattern with regex metachars is fine as a LITERAL.
    assert.doesNotThrow(() => makeSearchTool(root).validate({ pattern: "(a+)+b" }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("list: a root pointing into an ignored tree is treated as empty", async () => {
  const root = scratch();
  try {
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "x");
    const out = okOutput(await makeListTool(root).run({ path: "node_modules" }));
    assert.equal((out.entries as unknown[]).length, 0);
    assert.equal(out.ignored, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("search: a literal match past the 4KB regex cap is still found (full-line literal)", async () => {
  const root = scratch();
  try {
    writeFileSync(join(root, "min.js"), "x".repeat(5000) + "NEEDLE_TOKEN\n");
    const out = okOutput(await makeSearchTool(root).run({ pattern: "NEEDLE_TOKEN" }));
    assert.equal((out.matches as unknown[]).length, 1, "literal search must scan the whole line");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("globMatch: * stays within a segment, ** crosses segments (linear)", () => {
  assert.ok(globMatch("*.py", "main.py"));
  assert.ok(!globMatch("*.py", "actors/main.py"), "* must not cross /");
  assert.ok(globMatch("actors/**", "actors/deep/nested/main.py"));
  assert.ok(!globMatch("actors/**", "src/main.py"));
  assert.ok(globMatch("src/*.ts", "src/index.ts"));
  assert.ok(!globMatch("src/*.ts", "src/sub/index.ts"));
  assert.ok(globMatch("**/main.py", "a/b/c/main.py"));
  // `**/` = zero-or-more dirs, so a root-level file matches too.
  assert.ok(globMatch("**/main.py", "main.py"));
  assert.ok(globMatch("**/*.py", "main.py"));
  assert.ok(globMatch("**/*.py", "a/b/c.py"));
  assert.ok(!globMatch("**/*.py", "a/b/c.ts"));
  // A pathological ReDoS-shaped glob resolves fast (no exponential backtracking).
  assert.ok(!globMatch("*a*a*a*a*a*a*a*a*a*a*b", "a".repeat(64)));
});
