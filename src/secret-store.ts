/**
 * Local secret store (COW-2469, part 1/2).
 *
 * Lasso runs on the user's machine, so secrets can live locally: on macOS the
 * VALUE goes to the OS keychain (a generic password item per project+name);
 * elsewhere it falls back to a chmod-0600 `.cowboy/secrets.json`. Metadata
 * (which names exist, when they changed) lives in `.cowboy/secrets-index.json`
 * regardless of backend, so `list()` never has to parse keychain output.
 * Both files sit under `.cowboy/`, which the path sandbox already protects
 * from agent reads/writes and sync.
 *
 * Security posture:
 *   - Values are HEX-ENCODED before touching the `security` CLI or the file
 *     store. Hex has no quotes/newlines/shell metacharacters, which removes
 *     the entire quoting/injection class for `security -i` stdin commands.
 *   - `set` feeds the keychain via `security -i` over STDIN — the value never
 *     appears on argv, so it can't be captured from `ps`.
 *   - `get`/`delete` use argv-array execFile (no shell): the name is
 *     regex-validated and the service is passed as a single argv element.
 *   - The VALUE never leaves this module except through `getValue` — the
 *     bridge tools (part 2/2) expose metadata only to the backend.
 *
 * Known drift: a user can delete items from Keychain Access directly; the
 * index then lists a name whose `getValue` returns null. `list()` marks
 * nothing stale — callers treat a null value as "re-set it".
 */

import { execFile } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Read a private file refusing symlinks on BOTH components — a planted
 *  symlink must not read secrets out of another project either. Returns null
 *  when absent or refused. */
/** O_NOFOLLOW where the platform has it; 0 elsewhere (Windows) — those
 *  platforms rely on the explicit lstat checks below (small TOCTOU window,
 *  same residual class as COW-2634). */
const O_NOFOLLOW: number = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/** Final-component symlink check for platforms without O_NOFOLLOW. */
function isSymlinkAt(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false; // absent → not a symlink
  }
}

function readPrivate(path: string): string | null {
  try {
    if (lstatSync(dirname(path)).isSymbolicLink()) return null;
  } catch {
    return null; // no .cowboy dir at all
  }
  if (O_NOFOLLOW === 0 && isSymlinkAt(path)) return null;
  try {
    const fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
    try {
      return readFileSync(fd, "utf-8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null; // absent, or a symlink refused by O_NOFOLLOW (ELOOP)
  }
}

/** Env-style secret names. Anchored + bounded: argv- and file-key-safe. */
export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function validateSecretName(name: string): void {
  // typeof first: RegExp.test coerces, so a null/undefined from untyped tool
  // args would pass as the literal strings "null"/"undefined".
  if (typeof name !== "string" || !SECRET_NAME_RE.test(name)) {
    throw new Error(
      `secret: invalid name ${JSON.stringify(String(name).slice(0, 80))} (use [A-Za-z_][A-Za-z0-9_]{0,63})`
    );
  }
}

export interface SecretMeta {
  name: string;
  backend: "keychain" | "file";
  updatedAtMs: number;
}

export interface SecretStore {
  readonly backend: "keychain" | "file";
  /** Store (create or replace) a secret value. */
  set(name: string, value: string): Promise<void>;
  /** The stored value, or null when absent (or removed out-of-band). */
  getValue(name: string): Promise<string | null>;
  /** Remove a secret. Returns whether something was removed. */
  remove(name: string): Promise<boolean>;
  /** Metadata only — never values. */
  list(): Promise<SecretMeta[]>;
}

// ── Injectable `security` runner (real child process in prod, fake in tests) ─

export interface SecurityRunResult {
  stdout: string;
  exitCode: number;
}

export type SecurityRunner = (
  argv: string[],
  stdinLine?: string
) => Promise<SecurityRunResult>;

const runSecurityChild: SecurityRunner = (argv, stdinLine) =>
  new Promise((resolve) => {
    const child = execFile(
      // Absolute path: this child receives secret material on stdin, so it
      // must never resolve through PATH (a writable dir earlier in PATH could
      // shadow `security` with a harvester).
      "/usr/bin/security",
      argv,
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code?: number }).code as number)
            : err
              ? 1
              : 0;
        resolve({ stdout: String(stdout ?? ""), exitCode: code });
      }
    );
    if (stdinLine !== undefined) {
      child.stdin?.write(stdinLine + "\n");
    }
    child.stdin?.end();
  });

// ── Index file (metadata only, both backends) ────────────────────────────────

interface IndexShape {
  version: 1;
  secrets: Record<string, { updatedAtMs: number }>;
}

function indexPath(root: string): string {
  return join(root, ".cowboy", "secrets-index.json");
}

/** Null-prototype copy: names like `__proto__` or `constructor` must behave
 *  as plain own keys, not hit inherited setters (silent-drop / false hits). */
function ownMap<T>(raw: unknown): Record<string, T> {
  const out: Record<string, T> = Object.create(null) as Record<string, T>;
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(raw as Record<string, T>)) {
      out[key] = (raw as Record<string, T>)[key];
    }
  }
  return out;
}

function loadIndex(root: string): IndexShape {
  try {
    const text = readPrivate(indexPath(root));
    if (text === null) return { version: 1, secrets: ownMap(null) };
    const raw = JSON.parse(text) as Partial<IndexShape>;
    const secrets = ownMap<{ updatedAtMs: number }>(raw.secrets);
    // Tolerating a corrupt index means per-ENTRY too: a null / shape-less
    // value must drop out here, not throw later in list().
    for (const key of Object.keys(secrets)) {
      const meta = secrets[key] as unknown;
      if (
        !meta ||
        typeof meta !== "object" ||
        typeof (meta as { updatedAtMs?: unknown }).updatedAtMs !== "number"
      ) {
        delete secrets[key];
      }
    }
    return { version: 1, secrets };
  } catch {
    return { version: 1, secrets: ownMap(null) };
  }
}

function writePrivate(path: string, content: string): void {
  // A hostile checkout can plant `.cowboy` (or the file itself) as a symlink
  // pointing outside the project; following it would overwrite + chmod the
  // target. The dir is lstat-checked and the file is opened O_NOFOLLOW, so
  // the final-component follow is refused by the kernel, not by a racy check.
  const dir = dirname(path);
  try {
    const ds = lstatSync(dir);
    if (ds.isSymbolicLink() || !ds.isDirectory()) {
      throw new Error(`secret: refusing to write through ${dir} (not a real directory)`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    mkdirSync(dir, { recursive: true });
  }
  if (O_NOFOLLOW === 0 && isSymlinkAt(path)) {
    throw new Error(`secret: refusing to write through a symlinked ${path}`);
  }
  const fd = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | O_NOFOLLOW,
    0o600
  );
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  // The mode applies only on CREATE — re-assert on overwrite so a file that
  // ever existed with looser permissions is tightened.
  chmodSync(path, 0o600);
}

function saveIndex(root: string, index: IndexShape): void {
  writePrivate(indexPath(root), JSON.stringify(index, null, 2) + "\n");
}

// ── File fallback backend (hex values, 0600) ─────────────────────────────────

interface FileStoreShape {
  version: 1;
  secrets: Record<string, { valueHex: string }>;
}

function fileStorePath(root: string): string {
  return join(root, ".cowboy", "secrets.json");
}

function loadFileStore(root: string): FileStoreShape {
  try {
    const text = readPrivate(fileStorePath(root));
    if (text === null) return { version: 1, secrets: ownMap(null) };
    const raw = JSON.parse(text) as Partial<FileStoreShape>;
    return { version: 1, secrets: ownMap(raw.secrets) };
  } catch {
    return { version: 1, secrets: ownMap(null) };
  }
}

// ── Store factory ────────────────────────────────────────────────────────────

export interface SecretStoreOptions {
  /** Project root — scopes the keychain service + holds the fallback files. */
  root: string;
  /** Injected for tests. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Injected for tests. Defaults to a real `security` child process. */
  runSecurity?: SecurityRunner;
  /** Injected for tests. Defaults to Date.now. */
  now?: () => number;
}

/** Keychain service string for a project. The root path is embedded readable
 *  (it shows up in Keychain Access); a path carrying quotes or control chars
 *  can't be represented in a `security -i` quoted string, so those projects
 *  use the file backend instead. */
export function keychainService(root: string): string | null {
  if (/["\\\u0000-\u001f\u007f]/.test(root)) return null;
  return `cowboy-lasso:${root}`;
}

export function makeSecretStore(opts: SecretStoreOptions): SecretStore {
  const root = opts.root;
  const platform = opts.platform ?? process.platform;
  const runSecurity = opts.runSecurity ?? runSecurityChild;
  const now = opts.now ?? Date.now;
  const service = keychainService(root);
  const backend: "keychain" | "file" =
    platform === "darwin" && service !== null ? "keychain" : "file";

  const touchIndex = (name: string): void => {
    const index = loadIndex(root);
    index.secrets[name] = { updatedAtMs: now() };
    saveIndex(root, index);
  };
  const dropIndex = (name: string): boolean => {
    const index = loadIndex(root);
    const had = name in index.secrets;
    if (had) {
      delete index.secrets[name];
      saveIndex(root, index);
    }
    return had;
  };

  if (backend === "file") {
    return {
      backend,
      async set(name: string, value: string): Promise<void> {
        validateSecretName(name);
        // Index FIRST: if metadata can't be written (symlinked/unwritable
        // index), fail before any value persists — a stored secret that
        // list() can't see is worse than a clean failure.
        const hadEntry = name in loadIndex(root).secrets;
        touchIndex(name);
        try {
          const store = loadFileStore(root);
          store.secrets[name] = { valueHex: Buffer.from(value, "utf-8").toString("hex") };
          writePrivate(fileStorePath(root), JSON.stringify(store, null, 2) + "\n");
        } catch (e) {
          if (!hadEntry) dropIndex(name); // best-effort rollback of the reservation
          throw e;
        }
      },
      async getValue(name: string): Promise<string | null> {
        validateSecretName(name);
        const entry = loadFileStore(root).secrets[name];
        // Same rule as the keychain path: non-hex OR odd length = corrupt —
        // Buffer.from would silently drop a dangling nibble.
        if (
          !entry ||
          typeof entry.valueHex !== "string" ||
          !/^[0-9a-f]*$/i.test(entry.valueHex) ||
          entry.valueHex.length % 2 !== 0
        ) {
          return null;
        }
        return Buffer.from(entry.valueHex, "hex").toString("utf-8");
      },
      async remove(name: string): Promise<boolean> {
        validateSecretName(name);
        const store = loadFileStore(root);
        const had = name in store.secrets;
        if (had) {
          delete store.secrets[name];
          writePrivate(fileStorePath(root), JSON.stringify(store, null, 2) + "\n");
        }
        return dropIndex(name) || had;
      },
      async list(): Promise<SecretMeta[]> {
        const index = loadIndex(root);
        return Object.entries(index.secrets)
          .map(([name, meta]) => ({ name, backend, updatedAtMs: meta.updatedAtMs }))
          .sort((a, b) => a.name.localeCompare(b.name));
      },
    };
  }

  // Keychain backend. `service` is non-null here by construction.
  const svc = service as string;
  return {
    backend,
    async set(name: string, value: string): Promise<void> {
      validateSecretName(name);
      // -U upserts. The value is hex (no quoting hazards); the service is a
      // double-quoted string whose only risky chars were rejected upfront.
      const valueHex = Buffer.from(value, "utf-8").toString("hex");
      // Index FIRST (same rationale as the file backend): an unwritable index
      // must fail the set before the keychain holds an untracked value.
      const hadEntry = name in loadIndex(root).secrets;
      touchIndex(name);
      const line = `add-generic-password -U -a ${name} -s "${svc}" -w ${valueHex || '""'}`;
      const res = await runSecurity(["-i"], line);
      if (res.exitCode !== 0) {
        if (!hadEntry) dropIndex(name); // best-effort rollback of the reservation
        throw new Error(`secret: keychain write failed (security exit ${res.exitCode})`);
      }
    },
    async getValue(name: string): Promise<string | null> {
      validateSecretName(name);
      const res = await runSecurity([
        "find-generic-password",
        "-a",
        name,
        "-s",
        svc,
        "-w",
      ]);
      if (res.exitCode !== 0) return null;
      const hex = res.stdout.trim();
      if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) return null;
      return Buffer.from(hex, "hex").toString("utf-8");
    },
    async remove(name: string): Promise<boolean> {
      validateSecretName(name);
      const res = await runSecurity([
        "delete-generic-password",
        "-a",
        name,
        "-s",
        svc,
      ]);
      // 0 = deleted; 44 (errSecItemNotFound) = already gone (out-of-band
      // removal) — both may drop the index entry. Any other failure (locked
      // keychain, denied prompt) keeps the metadata: hiding a secret that
      // still exists in the keychain would be lying in `list()`.
      if (res.exitCode !== 0 && res.exitCode !== 44) {
        throw new Error(`secret: keychain delete failed (security exit ${res.exitCode})`);
      }
      const dropped = dropIndex(name);
      return res.exitCode === 0 || dropped;
    },
    async list(): Promise<SecretMeta[]> {
      const index = loadIndex(root);
      return Object.entries(index.secrets)
        .map(([name, meta]) => ({ name, backend, updatedAtMs: meta.updatedAtMs }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}
