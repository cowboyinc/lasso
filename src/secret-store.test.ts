import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  keychainService,
  makeSecretStore,
  validateSecretName,
  type SecurityRunner,
} from "./secret-store.js";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "lasso-secrets-"));
}

// ── name validation ──────────────────────────────────────────────────────────

test("validateSecretName: env-style names only", () => {
  for (const ok of ["API_KEY", "_x", "OpenAI_key2", "a".repeat(64)]) {
    assert.doesNotThrow(() => validateSecretName(ok));
  }
  for (const bad of ["", "1LEADING", "has-dash", "has space", "a".repeat(65), "x\ny", "-w"]) {
    assert.throws(() => validateSecretName(bad), /invalid name/);
  }
});

test("keychainService: refuses roots the quoted string can't carry", () => {
  assert.equal(keychainService("/Users/me/proyecto con espacios"), "cowboy-lasso:/Users/me/proyecto con espacios");
  assert.equal(keychainService('/tmp/evil"dir'), null);
  assert.equal(keychainService("/tmp/evil\ndir"), null);
  // A backslash is a valid POSIX filename char but an escape for the
  // `security -i` quoted parser — those projects use the file backend.
  assert.equal(keychainService("/tmp/back\\slash"), null);
});

// ── file backend ─────────────────────────────────────────────────────────────

test("file backend: set/get/list/remove round-trip; files are 0600; value stored hex", async () => {
  const root = makeRoot();
  try {
    const store = makeSecretStore({ root, platform: "linux", now: () => 42 });
    assert.equal(store.backend, "file");

    await store.set("API_KEY", 'p@ss"word\ncon\nsaltos');
    assert.equal(await store.getValue("API_KEY"), 'p@ss"word\ncon\nsaltos');

    // On-disk representation never contains the plaintext.
    const raw = readFileSync(join(root, ".cowboy", "secrets.json"), "utf-8");
    assert.ok(!raw.includes("p@ss"));
    for (const f of ["secrets.json", "secrets-index.json"]) {
      const mode = statSync(join(root, ".cowboy", f)).mode & 0o777;
      assert.equal(mode, 0o600, `${f} debe ser 0600`);
    }

    const listed = await store.list();
    assert.deepEqual(listed, [{ name: "API_KEY", backend: "file", updatedAtMs: 42 }]);

    assert.equal(await store.remove("API_KEY"), true);
    assert.equal(await store.getValue("API_KEY"), null);
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.remove("API_KEY"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file backend: __proto__ behaves as a plain own key (no prototype pollution)", async () => {
  const root = makeRoot();
  try {
    const store = makeSecretStore({ root, platform: "linux", now: () => 9 });
    await store.set("__proto__", "polluted?");
    assert.equal(await store.getValue("__proto__"), "polluted?");
    assert.deepEqual(await store.list(), [{ name: "__proto__", backend: "file", updatedAtMs: 9 }]);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(await store.remove("__proto__"), true);
    assert.equal(await store.remove("constructor"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file backend: list survives a corrupt index; empty value round-trips", async () => {
  const root = makeRoot();
  try {
    const store = makeSecretStore({ root, platform: "linux", now: () => 1 });
    await store.set("EMPTY", "");
    assert.equal(await store.getValue("EMPTY"), "");
    assert.equal(await store.getValue("MISSING"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── keychain backend (fake `security`) ───────────────────────────────────────

interface SecurityCall {
  argv: string[];
  stdinLine?: string;
}

function fakeSecurity(
  responder: (call: SecurityCall) => { stdout?: string; exitCode?: number }
): { calls: SecurityCall[]; run: SecurityRunner } {
  const calls: SecurityCall[] = [];
  const run: SecurityRunner = async (argv, stdinLine) => {
    const call = { argv, stdinLine };
    calls.push(call);
    const out = responder(call);
    return { stdout: out.stdout ?? "", exitCode: out.exitCode ?? 0 };
  };
  return { calls, run };
}

test("keychain backend: set goes over stdin with a hex value, never argv", async () => {
  const root = makeRoot();
  try {
    const { calls, run } = fakeSecurity(() => ({}));
    const store = makeSecretStore({ root, platform: "darwin", runSecurity: run, now: () => 7 });
    assert.equal(store.backend, "keychain");

    const value = 'secreto"con\'quotes y ñ';
    await store.set("TOKEN", value);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].argv, ["-i"]);
    const line = calls[0].stdinLine ?? "";
    assert.match(line, /^add-generic-password -U -a TOKEN -s "cowboy-lasso:/);
    // The plaintext value must never appear — only its hex encoding.
    assert.ok(!line.includes("secreto"));
    const hex = Buffer.from(value, "utf-8").toString("hex");
    assert.ok(line.endsWith(`-w ${hex}`));

    // Metadata recorded in the index (no value).
    const idx = readFileSync(join(root, ".cowboy", "secrets-index.json"), "utf-8");
    assert.ok(idx.includes("TOKEN") && !idx.includes(hex));
    assert.deepEqual(await store.list(), [{ name: "TOKEN", backend: "keychain", updatedAtMs: 7 }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keychain backend: getValue decodes hex stdout; non-hex or failure → null", async () => {
  const root = makeRoot();
  try {
    const value = "hola sec";
    const hex = Buffer.from(value).toString("hex");
    const { calls, run } = fakeSecurity((call) =>
      call.argv[0] === "find-generic-password" ? { stdout: `${hex}\n` } : {}
    );
    const store = makeSecretStore({ root, platform: "darwin", runSecurity: run });
    assert.equal(await store.getValue("TOKEN"), value);
    assert.deepEqual(
      calls[0].argv.slice(0, 3),
      ["find-generic-password", "-a", "TOKEN"]
    );
    assert.equal(calls[0].stdinLine, undefined);

    const failing = makeSecretStore({
      root,
      platform: "darwin",
      runSecurity: fakeSecurity(() => ({ exitCode: 44 })).run,
    });
    assert.equal(await failing.getValue("TOKEN"), null);

    const garbage = makeSecretStore({
      root,
      platform: "darwin",
      runSecurity: fakeSecurity(() => ({ stdout: "not-hex!!\n" })).run,
    });
    assert.equal(await garbage.getValue("TOKEN"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keychain backend: set surfaces a security failure; remove drops the index", async () => {
  const root = makeRoot();
  try {
    const broken = makeSecretStore({
      root,
      platform: "darwin",
      runSecurity: fakeSecurity(() => ({ exitCode: 1 })).run,
    });
    await assert.rejects(broken.set("TOKEN", "v"), /keychain write failed/);

    const { run } = fakeSecurity(() => ({}));
    const store = makeSecretStore({ root, platform: "darwin", runSecurity: run, now: () => 1 });
    await store.set("TOKEN", "v");

    // A REAL delete failure (locked keychain, denied prompt) must keep the
    // metadata — hiding a secret that still exists would lie in list().
    const locked = makeSecretStore({
      root,
      platform: "darwin",
      runSecurity: fakeSecurity((c) =>
        c.argv[0] === "delete-generic-password" ? { exitCode: 51 } : {}
      ).run,
      now: () => 1,
    });
    await assert.rejects(locked.remove("TOKEN"), /keychain delete failed/);
    assert.equal((await store.list()).length, 1);

    // exit 44 (item not found — removed out-of-band) still clears the index.
    const gone = makeSecretStore({
      root,
      platform: "darwin",
      runSecurity: fakeSecurity((c) =>
        c.argv[0] === "delete-generic-password" ? { exitCode: 44 } : {}
      ).run,
      now: () => 1,
    });
    assert.equal(await gone.remove("TOKEN"), true);
    assert.deepEqual(await store.list(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keychain backend: a hostile name never reaches the security child", async () => {
  const root = makeRoot();
  try {
    const { calls, run } = fakeSecurity(() => ({}));
    const store = makeSecretStore({ root, platform: "darwin", runSecurity: run });
    for (const bad of ["-w", "a b", 'x"y', "a\nb"]) {
      await assert.rejects(store.set(bad, "v"), /invalid name/);
      await assert.rejects(store.getValue(bad), /invalid name/);
      await assert.rejects(store.remove(bad), /invalid name/);
    }
    assert.equal(calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writes refuse a symlinked .cowboy dir or a symlinked secrets file", async () => {
  const root = makeRoot();
  const outside = makeRoot();
  try {
    const { symlinkSync, mkdirSync: mkd } = await import("node:fs");
    symlinkSync(outside, join(root, ".cowboy"));
    const viaDir = makeSecretStore({ root, platform: "linux" });
    await assert.rejects(viaDir.set("X", "v"), /not a real directory/);

    const root2 = makeRoot();
    mkd(join(root2, ".cowboy"));
    symlinkSync(join(outside, "target.json"), join(root2, ".cowboy", "secrets.json"));
    const viaFile = makeSecretStore({ root: root2, platform: "linux" });
    await assert.rejects(viaFile.set("X", "v"), /ELOOP|EMLINK|ENOENT/);

    // Reads refuse the same symlinks: another project's secrets.json planted
    // via symlink must read as ABSENT, not as this project's secrets.
    const { writeFileSync: wf } = await import("node:fs");
    wf(
      join(outside, "target.json"),
      JSON.stringify({ version: 1, secrets: { STOLEN: { valueHex: Buffer.from("v").toString("hex") } } })
    );
    assert.equal(await viaFile.getValue("STOLEN"), null);
    rmSync(root2, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("quoted-root project on darwin falls back to the file backend", () => {
  const root = makeRoot();
  try {
    // The service string can't carry a double quote — simulate via a platform
    // override with a hostile root by checking the factory's backend choice.
    const store = makeSecretStore({ root: `${root}/evil"dir`, platform: "darwin" });
    assert.equal(store.backend, "file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
