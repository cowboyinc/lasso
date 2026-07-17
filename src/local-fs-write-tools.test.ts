import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeWriteFileTool,
  makePatchFileTool,
  applyEdit,
} from "./local-fs-write-tools.js";
import type { ClientToolResult } from "./client-tool-bridge.js";

function scratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "lasso-fsw-")));
}
function errCode(res: ClientToolResult): string | undefined {
  return res.status === "error" ? res.errorCode : undefined;
}
function okOutput(res: ClientToolResult): Record<string, unknown> {
  assert.equal(res.status, "ok", `expected ok, got ${JSON.stringify(res)}`);
  return (res as { status: "ok"; output: unknown }).output as Record<string, unknown>;
}

// ── applyEdit — faithful mirror of the backend patch semantics ───────────────
// Shared fixture: keep these cases identical to dashboard workspace.ts applyEdit.

test("applyEdit: exact unique replace", () => {
  const r = applyEdit("a\nfoo\nb", "foo", "bar", false);
  assert.deepEqual(r, { ok: true, result: "a\nbar\nb", count: 1 });
});

test("applyEdit: ambiguous exact match errors unless replace_all", () => {
  assert.equal(applyEdit("x x", "x", "y", false).ok, false);
  assert.deepEqual(applyEdit("x x", "x", "y", true), { ok: true, result: "y y", count: 2 });
});

test("applyEdit: empty / identical are rejected", () => {
  assert.equal(applyEdit("a", "", "b", false).ok, false);
  assert.equal(applyEdit("a", "a", "a", false).ok, false);
});

test("applyEdit: whitespace-insensitive line-block fallback", () => {
  // indentation differs, but the trimmed line-block matches
  const content = "def f():\n    return 1\n";
  const r = applyEdit(content, "def f():\nreturn 1", "def f():\n    return 2", false);
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.result, /return 2/);
});

test("applyEdit: overlapping fallback matches don't corrupt (non-overlapping only)", () => {
  const r = applyEdit("a\na\na", "a\na", "X\nY", true);
  assert.equal(r.ok, true);
  // Only the first non-overlapping block replaced; the trailing `a` remains.
  if (r.ok) {
    assert.equal(r.count, 1);
    assert.equal(r.result, "X\nY\na");
  }
});

test("applyEdit: not found reports both strategies", () => {
  const r = applyEdit("hello", "zzz", "q", false);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /not found/);
});

// ── local_write_file ─────────────────────────────────────────────────────────

test("write: creates a new in-project file (and parent dirs)", async () => {
  const root = scratch();
  try {
    const out = okOutput(await makeWriteFileTool(root).run({ path: "actors/x/main.py", content: "print(1)\n" }));
    assert.equal(out.scope, "inside");
    assert.equal(readFileSync(join(root, "actors/x/main.py"), "utf-8"), "print(1)\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write: a traversal/escape target is refused defensively", async () => {
  const root = scratch();
  const outside = scratch();
  try {
    assert.equal(errCode(await makeWriteFileTool(root).run({ path: "../evil.py", content: "x" })), "denied_invalid");
    // a symlinked dir escaping the project → invalid
    symlinkSync(outside, join(root, "link"));
    assert.equal(
      errCode(await makeWriteFileTool(root).run({ path: "link/evil.py", content: "x" })),
      "denied_invalid"
    );
    assert.throws(() => readFileSync(join(outside, "evil.py")));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("write: an outside target is refused — agent writes stay in the project", async () => {
  const root = scratch();
  const outside = scratch();
  try {
    const target = join(outside, "note.txt");
    assert.equal(errCode(await makeWriteFileTool(root).run({ path: target, content: "ok" })), "denied_outside");
    assert.throws(() => readFileSync(target), "nothing written outside");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("write: preserves the existing file's mode across an overwrite", async () => {
  const root = scratch();
  try {
    const p = join(root, "run.sh");
    writeFileSync(p, "#!/bin/sh\n");
    (await import("node:fs")).chmodSync(p, 0o755);
    await makeWriteFileTool(root).run({ path: "run.sh", content: "#!/bin/sh\necho hi\n" });
    const mode = (await import("node:fs")).statSync(p).mode & 0o777;
    assert.equal(mode, 0o755, "executable bit preserved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write: content over the byte cap is rejected at validate", () => {
  const root = scratch();
  try {
    assert.throws(() => makeWriteFileTool(root).validate({ path: "a", content: "x".repeat(6 * 1024 * 1024) }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── local_patch_file ─────────────────────────────────────────────────────────

test("patch: applies a surgical edit and writes it back", async () => {
  const root = scratch();
  try {
    mkdirSync(join(root, "actors"));
    writeFileSync(join(root, "actors", "a.py"), "x = 1\ny = 2\n");
    const out = okOutput(
      await makePatchFileTool(root).run({ path: "actors/a.py", old_string: "x = 1", new_string: "x = 42" })
    );
    assert.equal(out.replaced, 1);
    assert.equal(readFileSync(join(root, "actors", "a.py"), "utf-8"), "x = 42\ny = 2\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patch: ambiguous match errors (no_edit) and does not write", async () => {
  const root = scratch();
  try {
    writeFileSync(join(root, "a.py"), "z\nz\n");
    const res = await makePatchFileTool(root).run({ path: "a.py", old_string: "z", new_string: "q" });
    assert.equal(errCode(res), "no_edit");
    assert.equal(readFileSync(join(root, "a.py"), "utf-8"), "z\nz\n", "file unchanged on failed patch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patch: missing file / binary / traversal are refused", async () => {
  const root = scratch();
  try {
    assert.equal(errCode(await makePatchFileTool(root).run({ path: "nope.py", old_string: "a", new_string: "b" })), "not_found");
    writeFileSync(join(root, "blob.bin"), Buffer.from([0x00, 0x01, 0x02]));
    assert.equal(errCode(await makePatchFileTool(root).run({ path: "blob.bin", old_string: "a", new_string: "b" })), "binary_file");
    assert.equal(errCode(await makePatchFileTool(root).run({ path: "../x", old_string: "a", new_string: "b" })), "denied_invalid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patch: validation rejects empty old_string / oversized snippets", () => {
  const root = scratch();
  try {
    assert.throws(() => makePatchFileTool(root).validate({ path: "a", old_string: "", new_string: "b" }));
    assert.throws(() =>
      makePatchFileTool(root).validate({ path: "a", old_string: "x".repeat(300 * 1024), new_string: "b" })
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
