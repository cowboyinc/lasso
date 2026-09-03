import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_PUSH_FILE_BYTES,
  defaultVolumeName,
  volumeNameFromDir,
  WORKSPACE_VOLUME,
  collectLocalFiles,
  planPush,
  batchForUpload,
  runSyncPush,
  buildPullPlan,
  applyPullPlan,
  loadSyncState,
  saveSyncState,
  type LocalFile,
} from "./sync.js";
import { MAX_UPLOAD_FILES, MAX_UPLOAD_RAW_BYTES } from "./files-client.js";
import type { FilesClient, RemoteObject, UploadFile, VolumeInfo } from "./files-client.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "lasso-sync-"));
  mkdirSync(join(root, ".cowboy"), { recursive: true });
  writeFileSync(join(root, ".cowboy", "config.json"), "{}");
  return root;
}

interface FakeClientState {
  volumes: VolumeInfo[];
  objects: RemoteObject[];
  contents: Record<string, { content: string; truncated: boolean }>;
  uploads: Array<{ volume: string; files: UploadFile[] }>;
  created: string[];
}

function fakeClient(state: Partial<FakeClientState> = {}): {
  client: FilesClient;
  state: FakeClientState;
} {
  const full: FakeClientState = {
    volumes: state.volumes ?? [],
    objects: state.objects ?? [],
    contents: state.contents ?? {},
    uploads: state.uploads ?? [],
    created: state.created ?? [],
  };
  const client: FilesClient = {
    async listVolumes() {
      return full.volumes;
    },
    async listObjects() {
      return full.objects;
    },
    async readObject(_volume, path) {
      const found = full.contents[path];
      if (!found) throw new Error(`no fixture for ${path}`);
      return found;
    },
    async uploadFiles(volume, files) {
      full.uploads.push({ volume, files });
    },
    async createVolume(name) {
      full.created.push(name);
      full.volumes.push({
        volumeId: "0xv",
        volumeName: name,
        visibility: "public",
        sizeBytes: 0,
        encrypted: false,
      });
    },
  };
  return { client, state: full };
}

// ── volume naming ────────────────────────────────────────────────────────────

test("defaultVolumeName: is the harness workspace volume regardless of directory", () => {
  assert.equal(defaultVolumeName("/tmp/My Cool Project!"), WORKSPACE_VOLUME);
  assert.equal(defaultVolumeName("/srv/other"), "workspace");
});

test("volumeNameFromDir: sanitizes to the CIP-9 charset", () => {
  assert.equal(volumeNameFromDir("/tmp/My Cool Project!"), "My-Cool-Project-");
  assert.equal(volumeNameFromDir("/tmp/.hidden"), "hidden");
  assert.match(volumeNameFromDir(`/tmp/${"x".repeat(80)}`), /^x{64}$/);
  assert.equal(volumeNameFromDir("/tmp/---"), "project");
});

// ── enumeration ──────────────────────────────────────────────────────────────

test("collectLocalFiles: excludes protected, ignored dirs, and symlinks", () => {
  const root = makeProject();
  try {
    writeFileSync(join(root, "main.py"), "print(1)");
    writeFileSync(join(root, ".env"), "SECRET=1");
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(root, "node_modules", "dep", "index.js"), "x");
    mkdirSync(join(root, "actors"));
    writeFileSync(join(root, "actors", "a.py"), "y");
    symlinkSync("/etc/hosts", join(root, "link.txt"));

    const { files } = collectLocalFiles(root);
    const rels = files.map((f) => f.rel).sort();
    assert.deepEqual(rels, ["actors/a.py", "main.py"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectLocalFiles: pushes lockfiles despite write-protection, skips binaries", () => {
  const root = makeProject();
  try {
    writeFileSync(join(root, "package-lock.json"), "{}");
    writeFileSync(join(root, "bun.lock"), "{}");
    writeFileSync(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    writeFileSync(join(root, "main.py"), "print(1)");

    writeFileSync(join(root, "-dashname.txt"), "x");
    const { files, skippedBinary, skippedUnsupported } = collectLocalFiles(root);
    const rels = files.map((f) => f.rel).sort();
    assert.deepEqual(rels, ["bun.lock", "main.py", "package-lock.json"]);
    assert.deepEqual(skippedBinary, ["logo.png"]);
    assert.deepEqual(skippedUnsupported, ["-dashname.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── push planning ────────────────────────────────────────────────────────────

test("planPush: skips unchanged (size+mtime) and over-cap files", () => {
  const local: LocalFile[] = [
    { rel: "same.py", size: 5, mtimeMs: 100 },
    { rel: "changed.py", size: 6, mtimeMs: 200 },
    { rel: "new.py", size: 7, mtimeMs: 300 },
    { rel: "huge.bin", size: MAX_PUSH_FILE_BYTES + 1, mtimeMs: 400 },
  ];
  const plan = planPush(local, {
    volume: "v",
    volumeId: null,
    files: {
      "same.py": { size: 5, mtimeMs: 100 },
      "changed.py": { size: 6, mtimeMs: 150 }, // mtime moved
    },
  });
  assert.deepEqual(plan.upload.map((f) => f.rel), ["changed.py", "new.py"]);
  assert.equal(plan.skippedUnchanged, 1);
  assert.deepEqual(plan.skippedTooBig, ["huge.bin"]);
});

test("batchForUpload: respects the file-count and raw-byte caps", () => {
  const many: LocalFile[] = Array.from({ length: MAX_UPLOAD_FILES + 3 }, (_, i) => ({
    rel: `f${i}`,
    size: 1,
    mtimeMs: 0,
  }));
  const byCount = batchForUpload(many);
  assert.equal(byCount.length, 2);
  assert.equal(byCount[0].length, MAX_UPLOAD_FILES);

  const big: LocalFile[] = [
    { rel: "a", size: MAX_UPLOAD_RAW_BYTES - 10, mtimeMs: 0 },
    { rel: "b", size: 20, mtimeMs: 0 },
  ];
  const byBytes = batchForUpload(big);
  assert.equal(byBytes.length, 2);
});

// ── push end-to-end (fake client) ────────────────────────────────────────────

test("runSyncPush: creates a missing volume, uploads, and persists state incrementally", async () => {
  const root = makeProject();
  try {
    writeFileSync(join(root, "a.py"), "aaa");
    writeFileSync(join(root, "b.py"), "bbbb");
    const { client, state } = fakeClient();

    const result = await runSyncPush(client, root, "proj");
    assert.equal(result.createdVolume, true);
    assert.deepEqual(state.created, ["proj"]);
    assert.equal(result.pushed, 2);
    assert.equal(state.uploads.length, 1);
    assert.deepEqual(
      state.uploads[0].files.map((f) => f.remote).sort(),
      ["a.py", "b.py"]
    );

    const saved = loadSyncState(root);
    assert.equal(saved.volume, "proj");
    assert.equal(Object.keys(saved.files).length, 2);

    // Second push with nothing changed uploads nothing.
    const again = await runSyncPush(client, root, "proj");
    assert.equal(again.pushed, 0);
    assert.equal(again.skippedUnchanged, 2);
    assert.equal(state.uploads.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runSyncPush: a remotely deleted volume is re-seeded, not skipped as unchanged", async () => {
  const root = makeProject();
  try {
    writeFileSync(join(root, "a.py"), "aaa");
    const first = fakeClient();
    await runSyncPush(first.client, root, "proj");
    assert.equal(first.state.uploads.length, 1);

    // Same state on disk, but the remote volume is GONE (fresh fake client):
    // the push must recreate it AND upload everything again.
    const second = fakeClient();
    const result = await runSyncPush(second.client, root, "proj");
    assert.equal(result.createdVolume, true);
    assert.equal(result.pushed, 1);
    assert.equal(second.state.uploads.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runSyncPush: switching volumes ignores the other volume's cached state", async () => {
  const root = makeProject();
  try {
    writeFileSync(join(root, "a.py"), "aaa");
    const { client, state } = fakeClient();
    await runSyncPush(client, root, "volA");
    assert.equal(state.uploads.length, 1);

    // Unchanged file, DIFFERENT volume: must upload, not skip as unchanged.
    const result = await runSyncPush(client, root, "volB");
    assert.equal(result.pushed, 1);
    assert.equal(state.uploads.length, 2);
    assert.equal(loadSyncState(root).volume, "volB");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── pull planning ────────────────────────────────────────────────────────────

test("buildPullPlan: refuses escaping/protected remote paths, skips big/truncated", async () => {
  const root = makeProject();
  try {
    writeFileSync(join(root, "existing.py"), "old");
    const { client } = fakeClient({
      objects: [
        { path: "existing.py", sizeBytes: 3 },
        { path: "newfile.py", sizeBytes: 3 },
        { path: "../escape.py", sizeBytes: 3 },
        { path: ".env", sizeBytes: 3 },
        { path: ".cowboy/config.json", sizeBytes: 3 },
        { path: "big.bin", sizeBytes: 2 * 1024 * 1024 },
        { path: "cut.txt", sizeBytes: 10 },
        { path: "blob.bin", sizeBytes: 5 },
      ],
      contents: {
        "existing.py": { content: "new", truncated: false },
        "newfile.py": { content: "n", truncated: false },
        "cut.txt": { content: "partial", truncated: true },
        "blob.bin": { content: "ab\0cd", truncated: false },
      },
    });

    const plan = await buildPullPlan(client, root, "proj");
    assert.deepEqual(plan.writes.map((w) => w.rel).sort(), ["existing.py", "newfile.py"]);
    assert.equal(plan.writes.find((w) => w.rel === "existing.py")?.overwrite, true);
    assert.equal(plan.writes.find((w) => w.rel === "newfile.py")?.overwrite, false);
    assert.deepEqual(plan.refused.sort(), ["../escape.py", ".cowboy/config.json", ".env"].sort());
    assert.deepEqual(plan.skippedTooBig.sort(), ["big.bin", "blob.bin", "cut.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildPullPlan: refuses a remote path whose local parent is a regular file", async () => {
  const root = makeProject();
  try {
    writeFileSync(join(root, "foo"), "a plain file");
    const { client } = fakeClient({
      objects: [{ path: "foo/bar.txt", sizeBytes: 2 }],
      contents: { "foo/bar.txt": { content: "xx", truncated: false } },
    });
    const plan = await buildPullPlan(client, root, "proj");
    assert.equal(plan.writes.length, 0);
    assert.deepEqual(plan.refused, ["foo/bar.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildPullPlan: refuses an in-project symlink (lexical check, not resolved)", async () => {
  const root = makeProject();
  try {
    writeFileSync(join(root, "real.txt"), "target");
    symlinkSync(join(root, "real.txt"), join(root, "alias.txt"));
    const { client } = fakeClient({
      objects: [{ path: "alias.txt", sizeBytes: 2 }],
      contents: { "alias.txt": { content: "xx", truncated: false } },
    });
    const plan = await buildPullPlan(client, root, "proj");
    assert.equal(plan.writes.length, 0);
    assert.deepEqual(plan.refused, ["alias.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildPullPlan: refuses a path through a symlinked directory component", async () => {
  const root = makeProject();
  try {
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "alias"));
    const { client } = fakeClient({
      objects: [{ path: "alias/file.txt", sizeBytes: 2 }],
      contents: { "alias/file.txt": { content: "xx", truncated: false } },
    });
    const plan = await buildPullPlan(client, root, "proj");
    assert.equal(plan.writes.length, 0);
    assert.deepEqual(plan.refused, ["alias/file.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildPullPlan: refuses a symlink target instead of writing through it", async () => {
  const root = makeProject();
  try {
    symlinkSync("/etc/hosts", join(root, "aliased.txt"));
    const { client } = fakeClient({
      objects: [{ path: "aliased.txt", sizeBytes: 2 }],
      contents: { "aliased.txt": { content: "xx", truncated: false } },
    });
    const plan = await buildPullPlan(client, root, "proj");
    assert.equal(plan.writes.length, 0);
    assert.deepEqual(plan.refused, ["aliased.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildPullPlan: refuses an intra-plan file/descendant conflict", async () => {
  const root = makeProject();
  try {
    const { client } = fakeClient({
      objects: [
        { path: "foo", sizeBytes: 1 },
        { path: "foo/bar.txt", sizeBytes: 2 },
      ],
      contents: {
        foo: { content: "x", truncated: false },
        "foo/bar.txt": { content: "xx", truncated: false },
      },
    });
    const plan = await buildPullPlan(client, root, "proj");
    assert.deepEqual(plan.writes.map((w) => w.rel), ["foo"]);
    assert.deepEqual(plan.refused, ["foo/bar.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyPullPlan: writes files, creates parent dirs, and records state", async () => {
  const root = makeProject();
  try {
    const { client } = fakeClient({
      objects: [{ path: "deep/dir/file.py", sizeBytes: 4 }],
      contents: { "deep/dir/file.py": { content: "data", truncated: false } },
    });
    const plan = await buildPullPlan(client, root, "proj");
    const result = applyPullPlan(root, plan);
    assert.equal(result.written, 1);
    assert.equal(readFileSync(join(root, "deep", "dir", "file.py"), "utf-8"), "data");
    const saved = loadSyncState(root);
    assert.equal(saved.volume, "proj");
    assert.ok(saved.files["deep/dir/file.py"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildPullPlan: skips objects already in sync (state + local size match) before the cap", async () => {
  const root = makeProject();
  try {
    writeFileSync(join(root, "same.py"), "abc");
    saveSyncState(root, {
      volume: "proj",
      volumeId: "0xv",
      files: {
        "same.py": { size: 3, mtimeMs: 1, remoteMtime: 777 },
        "pushed.py": { size: 3, mtimeMs: 1 }, // push-recorded: no remote identity
      },
    });
    writeFileSync(join(root, "pushed.py"), "abc");
    const { client } = fakeClient({
      volumes: [
        { volumeId: "0xv", volumeName: "proj", visibility: "public", sizeBytes: 3, encrypted: false },
      ],
      objects: [
        { path: "same.py", sizeBytes: 3, mtime: 777 },
        { path: "pushed.py", sizeBytes: 3, mtime: 888 },
        { path: "fresh.py", sizeBytes: 2 },
      ],
      contents: {
        "pushed.py": { content: "abc", truncated: false },
        "fresh.py": { content: "xx", truncated: false },
      },
    });
    const plan = await buildPullPlan(client, root, "proj");
    // Only the pull-recorded identity (matching remoteMtime + size) skips;
    // a push-recorded entry without remote identity is fetched again.
    assert.deepEqual(plan.writes.map((w) => w.rel).sort(), ["fresh.py", "pushed.py"]);
    assert.equal(plan.skippedUnchanged, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── state round-trip ─────────────────────────────────────────────────────────

test("sync state: load tolerates a missing or corrupt file", () => {
  const root = makeProject();
  try {
    assert.deepEqual(loadSyncState(root), { volume: null, volumeId: null, files: {} });
    writeFileSync(join(root, ".cowboy", "sync.json"), "not json");
    assert.deepEqual(loadSyncState(root), { volume: null, volumeId: null, files: {} });
    saveSyncState(root, { volume: "v", volumeId: null, files: { a: { size: 1, mtimeMs: 2 } } });
    assert.equal(loadSyncState(root).volume, "v");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
