/**
 * Dashboard CBFS files API client (COW-2467, part 1/2).
 *
 * Lasso syncs the local project against the wallet's CBFS volume through the
 * dashboard backend's files API (`/api/wallet/:address/files...`). Every call
 * is authenticated with an hourly wallet-signature token:
 *
 *   sig = secp256k1_sign(keccak256(`cowboy-files-access:<addr-lower>:<bucket>`))
 *   headers: x-cowboy-files-sig = 0x || r || s || v   (65 bytes, hex)
 *            x-cowboy-files-ts  = <bucket>            (floor(now / 1h))
 *
 * Signing is DELEGATED to the `cowboy` CLI (`transaction sign-hash`, COW-2726)
 * so key material never enters this process — same posture as the agent
 * signing bridge. The token is cached per bucket and re-signed once on a 401
 * (bucket rollover mid-session or clock skew), never in a loop.
 *
 * Scope note: one token proves access to every volume the wallet can touch
 * for the whole hour — treat it like a session credential (kept in-memory
 * only, never written to disk or logs).
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { signHashLocally, type EcdsaSignature } from "./signer.js";

// ── Limits (mirror the backend; exported for the sync commands + tests) ──────

/** Max files per upload request (backend cap). */
export const MAX_UPLOAD_FILES = 20;
/** Max total RAW bytes per upload request, before base64 (backend cap). */
export const MAX_UPLOAD_RAW_BYTES = 10 * 1024 * 1024;
/** Backend viewer cap for `readObject` content. */
export const MAX_OBJECT_VIEW_BYTES = 1 * 1024 * 1024;
/** CIP-9 §6.1 volume name shape (no leading `-`, not `.`/`..`). */
export const VOLUME_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

// ── Token construction (pure helpers, unit-tested) ───────────────────────────

const FILES_TOKEN_PREFIX = "cowboy-files-access";
const BUCKET_MS = 3_600_000;

export function filesTokenBucket(nowMs: number): number {
  return Math.floor(nowMs / BUCKET_MS);
}

/** 0x-prefixed keccak256 of the access message for `bucket`. */
export function filesTokenHashHex(address: string, bucket: number): string {
  const message = `${FILES_TOKEN_PREFIX}:${address.toLowerCase()}:${bucket}`;
  return `0x${Buffer.from(keccak_256(new TextEncoder().encode(message))).toString("hex")}`;
}

/** Encode `{r,s,v}` as the header wire format: 0x || r(32) || s(32) || v(1). */
export function encodeFilesSignature(sig: EcdsaSignature): string {
  const strip = (value: string, name: string): string => {
    const hex = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error(`sync auth: malformed signature component ${name}`);
    }
    return hex.toLowerCase();
  };
  if (!Number.isInteger(sig.v) || sig.v < 0 || sig.v > 255) {
    throw new Error("sync auth: malformed signature component v");
  }
  return `0x${strip(sig.r, "r")}${strip(sig.s, "s")}${sig.v.toString(16).padStart(2, "0")}`;
}

// ── Client-side input validation (fail fast, mirror the backend's rules) ─────

export function validateVolumeName(name: string): void {
  if (!VOLUME_NAME_RE.test(name) || name.startsWith("-") || name === "." || name === "..") {
    throw new Error(
      `sync: invalid volume name "${name}" (allowed: [A-Za-z0-9._-], 1-64 chars, no leading '-')`
    );
  }
}

/** Reject remote paths the backend would refuse (and anything argv/URL-hostile).
 *  Control characters are rejected outright: a newline inside a remote path
 *  would let untrusted remote input inject fake lines into the pull approval
 *  plan the user reviews before local writes. */
export function validateRemotePath(path: string): void {
  const bad =
    path.length === 0 ||
    path !== path.trim() || // the backend trims before validating — a padded path would silently land elsewhere
    path.startsWith("-") ||
    path.startsWith("/") ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
  if (bad) {
    throw new Error(`sync: invalid remote path ${JSON.stringify(path.slice(0, 120))}`);
  }
}

// ── API shapes ───────────────────────────────────────────────────────────────

export interface VolumeInfo {
  volumeId: string;
  volumeName: string;
  visibility: string;
  sizeBytes: number;
  encrypted: boolean;
}

export interface RemoteObject {
  path: string;
  sizeBytes: number;
  mtime?: number;
}

export interface RemoteObjectContent {
  content: string;
  truncated: boolean;
}

export interface UploadFile {
  /** Remote path inside the volume (validated). */
  remote: string;
  /** Raw file bytes; base64-encoded on the wire by the client. */
  bytes: Buffer;
  contentType?: string;
}

/** Failure with the friendly, actionable message already attached. */
export class FilesApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "FilesApiError";
  }
}

// ── Client ───────────────────────────────────────────────────────────────────

export type SignHashFn = (hashHex: string, signal?: AbortSignal) => Promise<EcdsaSignature>;

export interface FilesClientOptions {
  dashboardUrl: string;
  walletAddress: string;
  /** Injected for tests; defaults to the cowboy-CLI signer. */
  signHash?: SignHashFn;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export interface FilesClient {
  listVolumes(signal?: AbortSignal): Promise<VolumeInfo[]>;
  listObjects(volumeName: string, signal?: AbortSignal): Promise<RemoteObject[]>;
  readObject(volumeName: string, path: string, signal?: AbortSignal): Promise<RemoteObjectContent>;
  uploadFiles(volumeName: string, files: UploadFile[], signal?: AbortSignal): Promise<void>;
  createVolume(
    volumeName: string,
    visibility: "public" | "private",
    signal?: AbortSignal
  ): Promise<void>;
}

export function makeFilesClient(opts: FilesClientOptions): FilesClient {
  const base = opts.dashboardUrl.replace(/\/$/, "");
  const address = opts.walletAddress.toLowerCase();
  const signHash = opts.signHash ?? signHashLocally;
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;

  // Token cache: one signature per hourly bucket. `mintToken(force)` bypasses
  // the cache exactly once per request on a 401 (rollover/skew), so a genuinely
  // rejected wallet can't loop the CLI signer.
  let cached: { bucket: number; sig: string } | null = null;
  const mintToken = async (
    force: boolean,
    signal?: AbortSignal
  ): Promise<{ sig: string; ts: string }> => {
    const bucket = filesTokenBucket(now());
    if (!force && cached && cached.bucket === bucket) {
      return { sig: cached.sig, ts: String(bucket) };
    }
    const signature = await signHash(filesTokenHashHex(address, bucket), signal);
    const sig = encodeFilesSignature(signature);
    cached = { bucket, sig };
    return { sig, ts: String(bucket) };
  };

  const friendly = (status: number, detail: string): FilesApiError => {
    if (status === 401 || status === 403) {
      return new FilesApiError(
        "sync: the backend rejected the wallet signature — check that the local wallet matches the dashboard wallet",
        status
      );
    }
    if (status === 409) {
      return new FilesApiError(
        "sync: this wallet has no active CBFS delegation — open the dashboard Files page and enable it, then retry",
        status
      );
    }
    if (status === 404) {
      return new FilesApiError(`sync: not found — ${detail}`, status);
    }
    return new FilesApiError(`sync: backend error (HTTP ${status}) — ${detail}`, status);
  };

  const request = async (
    method: "GET" | "POST",
    path: string,
    body: unknown,
    signal?: AbortSignal,
    options: { voidBody?: boolean } = {}
  ): Promise<unknown> => {
    let retriedAuth = false;
    for (;;) {
      const token = await mintToken(retriedAuth, signal);
      const resp = await fetchFn(`${base}/api/wallet/${address}${path}`, {
        method,
        headers: {
          "x-cowboy-files-sig": token.sig,
          "x-cowboy-files-ts": token.ts,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal,
      });
      if (resp.ok) {
        if (options.voidBody) {
          // Void endpoints (upload, createVolume) may legitimately answer with
          // an empty body (204) — the backend already acted, that's success.
          return resp.json().catch(() => ({}));
        }
        // Read endpoints MUST carry a body: mapping a missing one to defaults
        // would let an empty 200 read as `content: ""` and overwrite a local
        // file with nothing on pull.
        return resp.json().catch(() => {
          throw new FilesApiError(
            `sync: backend returned an empty/malformed body for ${method} ${path}`,
            resp.status
          );
        });
      }
      const detail = (await resp.text().catch(() => "")).slice(0, 200);
      if (resp.status === 401 && !retriedAuth) {
        retriedAuth = true; // one fresh signature: covers bucket rollover mid-session
        continue;
      }
      throw friendly(resp.status, detail);
    }
  };

  return {
    async listVolumes(signal?: AbortSignal): Promise<VolumeInfo[]> {
      const data = (await request("GET", "/files", undefined, signal)) as {
        volumes?: unknown[];
      };
      return (data.volumes ?? []).map((v) => {
        const vol = v as Record<string, unknown>;
        return {
          volumeId: String(vol.volumeId ?? ""),
          volumeName: String(vol.volumeName ?? ""),
          visibility: String(vol.visibility ?? ""),
          sizeBytes: Number(vol.sizeBytes ?? 0),
          encrypted: Boolean(vol.encrypted),
        };
      });
    },

    async listObjects(volumeName: string, signal?: AbortSignal): Promise<RemoteObject[]> {
      validateVolumeName(volumeName);
      const data = (await request(
        "GET",
        `/files/${encodeURIComponent(volumeName)}/objects`,
        undefined,
        signal
      )) as { objects?: unknown[] };
      return (data.objects ?? []).map((o) => {
        const obj = o as Record<string, unknown>;
        return {
          path: String(obj.path ?? ""),
          sizeBytes: Number(obj.sizeBytes ?? 0),
          mtime: typeof obj.mtime === "number" ? obj.mtime : undefined,
        };
      });
    },

    async readObject(
      volumeName: string,
      path: string,
      signal?: AbortSignal
    ): Promise<RemoteObjectContent> {
      validateVolumeName(volumeName);
      validateRemotePath(path);
      const data = (await request(
        "GET",
        `/files/${encodeURIComponent(volumeName)}/object?path=${encodeURIComponent(path)}`,
        undefined,
        signal
      )) as { content?: unknown; truncated?: unknown };
      if (typeof data.content !== "string") {
        // Fail closed: defaulting a malformed body to "" would let a pull
        // overwrite a local file with nothing.
        throw new FilesApiError(`sync: malformed object body for ${JSON.stringify(path)}`, 200);
      }
      return {
        content: data.content,
        truncated: Boolean(data.truncated),
      };
    },

    async uploadFiles(
      volumeName: string,
      files: UploadFile[],
      signal?: AbortSignal
    ): Promise<void> {
      validateVolumeName(volumeName);
      if (files.length === 0) return;
      if (files.length > MAX_UPLOAD_FILES) {
        throw new Error(
          `sync: upload batch has ${files.length} files (max ${MAX_UPLOAD_FILES}) — batch upstream`
        );
      }
      let totalRaw = 0;
      for (const f of files) {
        validateRemotePath(f.remote);
        totalRaw += f.bytes.byteLength;
      }
      if (totalRaw > MAX_UPLOAD_RAW_BYTES) {
        throw new Error(
          `sync: upload batch is ${totalRaw} raw bytes (max ${MAX_UPLOAD_RAW_BYTES}) — batch upstream`
        );
      }
      await request(
        "POST",
        `/files/${encodeURIComponent(volumeName)}/upload`,
        {
          files: files.map((f) => ({
            remote: f.remote,
            contentBase64: f.bytes.toString("base64"),
            ...(f.contentType ? { contentType: f.contentType } : {}),
          })),
        },
        signal,
        { voidBody: true }
      );
    },

    async createVolume(
      volumeName: string,
      visibility: "public" | "private",
      signal?: AbortSignal
    ): Promise<void> {
      validateVolumeName(volumeName);
      await request("POST", "/volumes", { name: volumeName, visibility }, signal, {
        voidBody: true,
      });
    },
  };
}
