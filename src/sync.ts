/**
 * Local ↔ CBFS workspace sync (COW-2467, part 2/2).
 *
 * `/sync push` uploads project files to the wallet's CBFS volume through the
 * dashboard files API; `/sync pull` materializes the volume into the local
 * project. Both directions ride the existing safety rails:
 *
 *   - push enumerates through the local-FS walker (ignored dirs skipped,
 *     symlinks never followed) and excludes the protected set (.env*,
 *     .cowboy/**, key material) — secrets can't leave the machine via sync.
 *   - pull treats remote paths/content as UNTRUSTED: a remote path must
 *     classify strictly `inside` the project (a protected or escaping path is
 *     refused, never prompted), and writes are atomic + mode-preserving via
 *     the same helper as the local write tools. Truncated remote reads are
 *     skipped — a partial file is worse than a missing one.
 *
 * `.cowboy/sync.json` records `{path → {size, mtimeMs}}` after either
 * direction; push uses it to skip unchanged files. Conflict detection and
 * `sync status` are deliberately out of scope here (COW-2468) — pull
 * overwrites local files only after the user approves the listed plan.
 */

import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  MAX_OBJECT_VIEW_BYTES,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_RAW_BYTES,
  validateRemotePath,
  type FilesClient,
  type UploadFile,
} from "./files-client.js";
import { toPosixRel, walkProject } from "./local-fs-tools.js";
import { atomicWrite } from "./local-fs-write-tools.js";
import { classifyWritePath, isProtectedRelative } from "./path-sandbox.js";

// ── Bounds ───────────────────────────────────────────────────────────────────

/** Cap on files considered per push — a project bigger than this needs a real
 *  sync strategy, not a bigger loop. */
export const MAX_PUSH_FILES = 500;
/** Push cap = the READ cap, not the upload cap: a file between the two would
 *  upload fine but `/sync pull` could never restore it (the read endpoint
 *  truncates at 1 MB) — sync only records state it can round-trip. */
export const MAX_PUSH_FILE_BYTES = MAX_OBJECT_VIEW_BYTES;
/** Pull plan bounds: contents are held in memory until approval, so both the
 *  file count and the total bytes are capped; the remainder is skipped and
 *  reported, never silently dropped. */
export const MAX_PULL_FILES = MAX_PUSH_FILES;
export const MAX_PULL_TOTAL_BYTES = 64 * 1024 * 1024;
const WALK_DEPTH = 12;
const SNIFF_BYTES = 4096;

/** Lockfiles are write-protected against agent/remote tampering, but READING
 *  them is harmless and a volume without them doesn't reproduce the project —
 *  so push includes them. The asymmetry is deliberate: pull still refuses
 *  them (protected), remote content can't rewrite a lockfile. */
const PUSHABLE_PROTECTED = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "Cargo.lock",
]);

/** Sync v1 is text-only: the backend read endpoint serves JSON text, so binary
 *  content can't round-trip. A NUL in the first chunk marks a file binary. */
function sniffBinaryFile(path: string, size: number): boolean {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(Math.min(SNIFF_BYTES, size));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

// ── Sync state (.cowboy/sync.json) ───────────────────────────────────────────

export interface SyncFileState {
  size: number;
  mtimeMs: number;
  /** Remote object mtime as reported by the backend at PULL time. Only pull
   *  records it — it's the remote identity that lets a later pull safely skip
   *  an object as unchanged (size alone can't: same-length edits exist). */
  remoteMtime?: number;
}

export interface SyncState {
  volume: string | null;
  /** Stable remote identity: a same-NAME volume that is a different volume
   *  (recreated, other wallet/backend) must not inherit the file map. */
  volumeId: string | null;
  files: Record<string, SyncFileState>;
}

const EMPTY_STATE: SyncState = { volume: null, volumeId: null, files: {} };

function syncStatePath(root: string): string {
  return join(root, ".cowboy", "sync.json");
}

export function loadSyncState(root: string): SyncState {
  try {
    const raw = JSON.parse(readFileSync(syncStatePath(root), "utf-8")) as Partial<SyncState>;
    return {
      volume: typeof raw.volume === "string" ? raw.volume : null,
      volumeId: typeof raw.volumeId === "string" ? raw.volumeId : null,
      files: raw.files && typeof raw.files === "object" ? (raw.files as SyncState["files"]) : {},
    };
  } catch {
    return { ...EMPTY_STATE, files: {} };
  }
}

export function saveSyncState(root: string, state: SyncState): void {
  const path = syncStatePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

// ── Volume naming ────────────────────────────────────────────────────────────

/** Derive a CIP-9-valid default volume name from the project directory. */
export function defaultVolumeName(root: string): string {
  const sanitized = basename(root)
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, 64);
  return sanitized || "project";
}

// ── Push ─────────────────────────────────────────────────────────────────────

export interface LocalFile {
  /** Posix-style path relative to the project root. */
  rel: string;
  size: number;
  mtimeMs: number;
}

export interface PushPlan {
  upload: LocalFile[];
  skippedUnchanged: number;
  /** Files that can never ship in one batch (over the raw byte cap). */
  skippedTooBig: string[];
  /** Walk hit a bound — coverage is partial and reported, never silent. */
  capped: boolean;
}

/** Enumerate pushable files: regular files only, ignored dirs skipped by the
 *  walker, protected paths excluded, symlinks never followed. */
export function collectLocalFiles(root: string, signal?: AbortSignal): {
  files: LocalFile[];
  skippedBinary: string[];
  skippedUnsupported: string[];
  capped: boolean;
} {
  const files: LocalFile[] = [];
  const skippedBinary: string[] = [];
  const skippedUnsupported: string[] = [];
  let hitFileCap = false;
  // A local name the remote API can't represent (leading '-', etc.) must be
  // skipped AND reported here — hitting the client-side validator later would
  // abort the whole batch instead.
  const remoteRepresentable = (rel: string): boolean => {
    try {
      validateRemotePath(rel);
      return true;
    } catch {
      skippedUnsupported.push(rel);
      return false;
    }
  };
  const caps = walkProject(
    root,
    "",
    WALK_DEPTH,
    (entry) => {
      if (entry.type !== "file") return true;
      const rel = toPosixRel(entry.rel);
      if (isProtectedRelative(rel) && !PUSHABLE_PROTECTED.has(rel)) return true;
      if (!remoteRepresentable(rel)) return true;
      if (files.length >= MAX_PUSH_FILES) {
        hitFileCap = true;
        return false;
      }
      let mtimeMs = 0;
      try {
        const abs = join(root, entry.rel);
        mtimeMs = statSync(abs).mtimeMs;
        if (entry.size > 0 && sniffBinaryFile(abs, entry.size)) {
          skippedBinary.push(rel);
          return true;
        }
      } catch {
        return true; // vanished mid-walk
      }
      files.push({ rel, size: entry.size, mtimeMs });
      return true;
    },
    signal
  );
  // The walker never surfaces protected entries, so the lockfile carve-out is
  // collected explicitly (root-level only — where lockfiles live).
  for (const name of PUSHABLE_PROTECTED) {
    try {
      const st = lstatSync(join(root, name));
      if (!st.isFile()) continue;
      if (files.length >= MAX_PUSH_FILES) {
        hitFileCap = true; // an existing lockfile was dropped — coverage is partial
        continue;
      }
      files.push({ rel: name, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* absent */
    }
  }
  return {
    files,
    skippedBinary,
    skippedUnsupported,
    capped: hitFileCap || caps.walkCapped || caps.dirCapped || caps.depthCapped,
  };
}

export function planPush(local: LocalFile[], state: SyncState): PushPlan {
  const upload: LocalFile[] = [];
  const skippedTooBig: string[] = [];
  let skippedUnchanged = 0;
  for (const file of local) {
    if (file.size > MAX_PUSH_FILE_BYTES) {
      skippedTooBig.push(file.rel);
      continue;
    }
    const known = state.files[file.rel];
    if (known && known.size === file.size && known.mtimeMs === file.mtimeMs) {
      skippedUnchanged++;
      continue;
    }
    upload.push(file);
  }
  return { upload, skippedUnchanged, skippedTooBig, capped: false };
}

/** Group files into upload batches under both backend caps. Files are already
 *  individually ≤ the byte cap (planPush filtered the rest). */
export function batchForUpload(files: LocalFile[]): LocalFile[][] {
  const batches: LocalFile[][] = [];
  let current: LocalFile[] = [];
  let currentBytes = 0;
  for (const file of files) {
    if (
      current.length >= MAX_UPLOAD_FILES ||
      (current.length > 0 && currentBytes + file.size > MAX_UPLOAD_RAW_BYTES)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += file.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export interface PushResult {
  volume: string;
  pushed: number;
  skippedUnchanged: number;
  skippedTooBig: string[];
  /** Binary files (NUL in the first chunk) — sync v1 is text-only. */
  skippedBinary: string[];
  /** Local names the remote API can't represent (e.g. a leading '-'). */
  skippedUnsupported: string[];
  capped: boolean;
  createdVolume: boolean;
}

export async function runSyncPush(
  client: FilesClient,
  root: string,
  volume: string,
  opts: { onProgress?: (line: string) => void; signal?: AbortSignal } = {}
): Promise<PushResult> {
  const progress = opts.onProgress ?? (() => {});

  // Existence first: the cached file map is only meaningful if the volume it
  // was recorded against STILL EXISTS remotely. A missing volume (never
  // created, or deleted since) starts from an empty map, or a fresh volume
  // would be seeded with zero files while everything skips as "unchanged".
  let createdVolume = false;
  let volumes = await client.listVolumes(opts.signal);
  if (!volumes.some((v) => v.volumeName === volume)) {
    progress(`Creating volume ${volume}…`);
    await client.createVolume(volume, "public", opts.signal);
    createdVolume = true;
    volumes = await client.listVolumes(opts.signal);
  }
  const volumeId = volumes.find((v) => v.volumeName === volume)?.volumeId ?? null;
  const loaded = loadSyncState(root);
  // Trust the cached map only for the SAME volume identity: same name +
  // same volumeId (a recreated/other-backend volume must be fully seeded).
  const sameIdentity =
    loaded.volume === volume &&
    !createdVolume &&
    loaded.volumeId !== null &&
    loaded.volumeId === volumeId;
  const state: SyncState = sameIdentity ? loaded : { volume, volumeId, files: {} };
  state.volumeId = volumeId;

  const { files: local, skippedBinary, skippedUnsupported, capped } = collectLocalFiles(
    root,
    opts.signal
  );
  const plan = planPush(local, state);

  const batches = batchForUpload(plan.upload);
  let pushed = 0;
  for (const batch of batches) {
    const payload: UploadFile[] = batch.map((file) => ({
      remote: file.rel,
      bytes: readFileSync(join(root, file.rel)),
    }));
    await client.uploadFiles(volume, payload, opts.signal);
    pushed += batch.length;
    progress(`Pushed ${pushed}/${plan.upload.length} files…`);
    for (const file of batch) {
      state.files[file.rel] = { size: file.size, mtimeMs: file.mtimeMs };
    }
    // Persist after every accepted batch: an interrupted push resumes where it
    // left off instead of re-uploading everything.
    state.volume = volume;
    saveSyncState(root, state);
  }
  if (batches.length === 0) {
    state.volume = volume;
    saveSyncState(root, state);
  }

  return {
    volume,
    pushed,
    skippedUnchanged: plan.skippedUnchanged,
    skippedTooBig: plan.skippedTooBig,
    skippedBinary,
    skippedUnsupported,
    capped,
    createdVolume,
  };
}

// ── Pull ─────────────────────────────────────────────────────────────────────

export interface PullPlanEntry {
  rel: string;
  /** Absolute, sandbox-resolved target (safe to write). */
  resolved: string;
  content: string;
  /** True when the local file already exists (an overwrite). */
  overwrite: boolean;
  /** Remote mtime, recorded into sync state so a later pull can skip it. */
  remoteMtime?: number;
}

export interface PullPlan {
  volume: string;
  volumeId: string | null;
  /** Objects skipped because the recorded sync state and the local file both
   *  match the remote size — a capped pull makes forward progress. */
  skippedUnchanged: number;
  writes: PullPlanEntry[];
  /** Remote paths refused by the sandbox (escaping/protected) or unsafe local
   *  targets (symlink / non-regular file). Never written, always reported. */
  refused: string[];
  /** Remote objects over the read cap or with truncated content. */
  skippedTooBig: string[];
  /** The plan hit its count/byte bound — remaining objects were skipped. */
  planCapped: boolean;
}

/** Build the pull plan: fetch remote objects and classify every target through
 *  the write sandbox. Remote input is untrusted — anything not strictly
 *  `inside` is refused outright (never prompted). No writes happen here; the
 *  caller shows the plan for approval and then calls `applyPullPlan`. */
export async function buildPullPlan(
  client: FilesClient,
  root: string,
  volume: string,
  opts: { onProgress?: (line: string) => void; signal?: AbortSignal } = {}
): Promise<PullPlan> {
  const progress = opts.onProgress ?? (() => {});
  const volumes = await client.listVolumes(opts.signal);
  const volumeId = volumes.find((v) => v.volumeName === volume)?.volumeId ?? null;
  const objects = await client.listObjects(volume, opts.signal);
  const writes: PullPlanEntry[] = [];
  const refused: string[] = [];
  const skippedTooBig: string[] = [];
  let skippedUnchanged = 0;
  let planCapped = false;

  // The recorded map is only trusted against the same volume identity.
  const state = loadSyncState(root);
  const trustState =
    state.volume === volume && state.volumeId !== null && state.volumeId === volumeId;

  let fetched = 0;
  let plannedBytes = 0;
  for (const obj of objects) {
    // Forward progress on big volumes: an object is skipped as unchanged only
    // when a PREVIOUS PULL recorded its remote identity (mtime + size) and
    // both still match, and the local file still has the recorded size. Size
    // alone is never enough — a same-length remote edit must not be skipped.
    // Push-recorded entries carry no remoteMtime, so a pull after a push
    // still fetches everything once. Real conflict detection is COW-2468.
    const known = trustState ? state.files[obj.path] : undefined;
    if (
      known?.remoteMtime !== undefined &&
      obj.mtime !== undefined &&
      known.remoteMtime === obj.mtime &&
      known.size === obj.sizeBytes
    ) {
      try {
        if (statSync(join(root, obj.path)).size === obj.sizeBytes) {
          skippedUnchanged++;
          continue;
        }
      } catch {
        /* local file gone — fall through and pull it */
      }
    }
    // Contents are held in memory until approval — bound the plan itself.
    if (writes.length >= MAX_PULL_FILES || plannedBytes + obj.sizeBytes > MAX_PULL_TOTAL_BYTES) {
      planCapped = true;
      skippedTooBig.push(obj.path);
      continue;
    }
    try {
      validateRemotePath(obj.path);
    } catch {
      refused.push(obj.path);
      continue;
    }
    if (obj.sizeBytes > MAX_OBJECT_VIEW_BYTES) {
      skippedTooBig.push(obj.path);
      continue;
    }
    const cls = classifyWritePath(obj.path, root);
    if (cls.scope !== "inside") {
      refused.push(obj.path);
      continue;
    }
    // Refuse to write through a symlink or over a non-regular file, same as
    // the local write tools. EVERY lexical component is checked, not just the
    // final one: with `alias -> real` in the project, `alias/file.txt` would
    // classify inside and lstat(resolved) would see a plain file, but the
    // approved plan would say `alias/…` while the bytes land in `real/…`.
    let symlinkComponent = false;
    {
      let prefix = root;
      for (const seg of obj.path.split("/")) {
        prefix = join(prefix, seg);
        try {
          if (lstatSync(prefix).isSymbolicLink()) {
            symlinkComponent = true;
            break;
          }
        } catch {
          break; // missing tail (a create) or ENOTDIR — handled on the resolved path
        }
      }
    }
    if (symlinkComponent) {
      refused.push(obj.path);
      continue;
    }
    let overwrite = false;
    try {
      const ls = lstatSync(cls.resolved);
      if (ls.isSymbolicLink() || !ls.isFile()) {
        refused.push(obj.path);
        continue;
      }
      overwrite = true;
    } catch (e) {
      // ENOTDIR = an existing local FILE sits where the remote path needs a
      // directory (`foo` file vs `foo/bar.txt`). Writing would fail after
      // approval, mid-plan — refuse it up front instead.
      if ((e as NodeJS.ErrnoException).code === "ENOTDIR") {
        refused.push(obj.path);
        continue;
      }
      /* ENOENT → a plain create */
    }
    const body = await client.readObject(volume, obj.path, opts.signal);
    if (body.truncated) {
      skippedTooBig.push(obj.path); // partial content must never hit disk
      continue;
    }
    if (body.content.includes("\0")) {
      // Binary served through the text endpoint can't round-trip — writing it
      // would corrupt the file. Sync v1 is text-only on both directions.
      skippedTooBig.push(obj.path);
      continue;
    }
    // Intra-plan consistency: a volume carrying both `foo` and `foo/bar.txt`
    // would produce an impossible plan (a path can't be a file and a dir) that
    // fails midway through apply. Later entry loses, reported as refused.
    const conflicts = writes.some(
      (w) => obj.path.startsWith(`${w.rel}/`) || w.rel.startsWith(`${obj.path}/`)
    );
    if (conflicts) {
      refused.push(obj.path);
      continue;
    }
    fetched++;
    if (fetched % 10 === 0) progress(`Fetched ${fetched}/${objects.length} files…`);
    plannedBytes += obj.sizeBytes;
    writes.push({
      rel: obj.path,
      resolved: cls.resolved,
      content: body.content,
      overwrite,
      remoteMtime: obj.mtime,
    });
  }

  return { volume, volumeId, skippedUnchanged, writes, refused, skippedTooBig, planCapped };
}

export interface PullResult {
  written: number;
  refused: string[];
  skippedTooBig: string[];
}

/** Apply an approved pull plan: atomic, mode-preserving writes + state update. */
export function applyPullPlan(root: string, plan: PullPlan): PullResult {
  const loaded = loadSyncState(root);
  // Same identity rule as push: a map recorded against another volume (name
  // OR volumeId mismatch) says nothing about this one.
  const sameIdentity =
    loaded.volume === plan.volume &&
    loaded.volumeId !== null &&
    loaded.volumeId === plan.volumeId;
  const state: SyncState = sameIdentity
    ? loaded
    : { volume: plan.volume, volumeId: plan.volumeId, files: {} };
  state.volumeId = plan.volumeId;
  let written = 0;
  for (const entry of plan.writes) {
    mkdirSync(dirname(entry.resolved), { recursive: true });
    atomicWrite(entry.resolved, entry.content);
    written++;
    const st = statSync(entry.resolved);
    state.files[entry.rel] = {
      size: st.size,
      mtimeMs: st.mtimeMs,
      ...(entry.remoteMtime !== undefined ? { remoteMtime: entry.remoteMtime } : {}),
    };
  }
  state.volume = plan.volume;
  saveSyncState(root, state);
  return { written, refused: plan.refused, skippedTooBig: plan.skippedTooBig };
}

// ── Rendering helpers (kept here so app.tsx stays thin) ──────────────────────

export function formatPushResult(r: PushResult): string {
  const lines = [
    `  Sync push → volume "${r.volume}"${r.createdVolume ? " (created)" : ""}`,
    "",
    `  Pushed:    ${r.pushed} file${r.pushed === 1 ? "" : "s"}`,
    `  Unchanged: ${r.skippedUnchanged} (skipped)`,
  ];
  if (r.skippedTooBig.length > 0) {
    lines.push(`  Too big:   ${r.skippedTooBig.length} skipped (${r.skippedTooBig.slice(0, 5).join(", ")}${r.skippedTooBig.length > 5 ? ", …" : ""})`);
  }
  if (r.skippedBinary.length > 0) {
    lines.push(`  Binary:    ${r.skippedBinary.length} skipped (sync is text-only for now)`);
  }
  if (r.skippedUnsupported.length > 0) {
    lines.push(`  Unsupported names: ${r.skippedUnsupported.join(", ")} (not representable remotely)`);
  }
  if (r.capped) {
    lines.push("  NOTE: the file walk hit a bound — coverage was partial. Re-run after pruning.");
  }
  return lines.join("\n");
}

export function formatPullSummary(plan: PullPlan): string {
  const creates = plan.writes.filter((w) => !w.overwrite).length;
  const overwrites = plan.writes.length - creates;
  // EVERY path is listed — approving unseen writes would defeat the review.
  const shown = plan.writes.map((w) => `    ${w.overwrite ? "~" : "+"} ${w.rel}`);
  const lines = [
    `${plan.writes.length} file${plan.writes.length === 1 ? "" : "s"} from volume "${plan.volume}" (${creates} new, ${overwrites} overwritten${plan.skippedUnchanged > 0 ? `, ${plan.skippedUnchanged} unchanged skipped` : ""})`,
    ...shown,
  ];
  // Refused/skipped names are UNTRUSTED remote strings — rendered escaped so
  // a newline inside a path can't inject fake lines into the reviewed plan.
  const escaped = (paths: string[]): string => paths.map((p) => JSON.stringify(p)).join(", ");
  if (plan.refused.length > 0) {
    lines.push(`  REFUSED (unsafe remote paths, never written): ${escaped(plan.refused)}`);
  }
  if (plan.skippedTooBig.length > 0) {
    lines.push(`  Skipped (read cap / binary / plan bound): ${escaped(plan.skippedTooBig)}`);
  }
  if (plan.planCapped) {
    lines.push("  NOTE: the plan hit its size bound — pull again after approving to fetch the rest.");
  }
  return lines.join("\n");
}

export function formatPullResult(r: PullResult): string {
  const lines = ["  Sync pull complete", "", `  Written: ${r.written} file${r.written === 1 ? "" : "s"}`];
  if (r.refused.length > 0) lines.push(`  Refused: ${r.refused.length} unsafe remote path${r.refused.length === 1 ? "" : "s"}`);
  if (r.skippedTooBig.length > 0) lines.push(`  Skipped: ${r.skippedTooBig.length} over the read cap`);
  return lines.join("\n");
}
