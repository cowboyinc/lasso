import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSetSecretTool, makeGetSecretTool } from "./secret-tools.js";
import type { SecretMeta, SecretStore } from "./secret-store.js";
import { decide } from "./permissions.js";

function fakeStore(initial: Record<string, string> = {}): {
  store: SecretStore;
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  const stamps = new Map<string, number>();
  let tick = 0;
  const store: SecretStore = {
    backend: "file",
    async set(name, value) {
      values.set(name, value);
      stamps.set(name, ++tick);
    },
    async getValue(name) {
      return values.get(name) ?? null;
    },
    async remove(name) {
      return values.delete(name);
    },
    async list(): Promise<SecretMeta[]> {
      // Metadata is tracked separately from values (like the real index), so
      // tests can simulate drift: a listed name whose value is gone.
      return [...stamps.keys()].map((name) => ({
        name,
        backend: "file",
        updatedAtMs: stamps.get(name) ?? 0,
      }));
    },
  };
  return { store, values };
}

// ── permission classes ───────────────────────────────────────────────────────

test("permissions: secret class allows in every mode (interactive by construction)", () => {
  assert.equal(decide("secret", "default"), "allow");
  assert.equal(decide("secret", "auto"), "allow");
  // Unknown classes still fail closed.
  assert.equal(decide("secrets", "default"), "deny");
});

// ── local_set_secret ─────────────────────────────────────────────────────────

test("set tool: prompts locally, stores, and returns metadata only", async () => {
  const { store, values } = fakeStore();
  const prompts: Array<{ name: string; reason?: string }> = [];
  const tool = makeSetSecretTool(store, async (name, reason) => {
    prompts.push({ name, reason });
    return "s3cr3t";
  });
  assert.equal(tool.permission, "secret");
  tool.validate({ name: "API_KEY", reason: "para el actor de clima" });
  const res = await tool.run({ name: "API_KEY", reason: "para el actor de clima" });
  assert.equal(res.status, "ok");
  // The value must never ride the tool result.
  assert.ok(!JSON.stringify(res).includes("s3cr3t"));
  assert.deepEqual(res.status === "ok" && res.output, {
    name: "API_KEY",
    stored: true,
    backend: "file",
  });
  assert.equal(values.get("API_KEY"), "s3cr3t");
  assert.deepEqual(prompts, [{ name: "API_KEY", reason: "para el actor de clima" }]);
});

test("set tool: a cancelled prompt cancels the tool and stores nothing", async () => {
  const { store, values } = fakeStore();
  const tool = makeSetSecretTool(store, async () => null);
  const res = await tool.run({ name: "API_KEY" });
  assert.deepEqual(res, { status: "cancelled", reason: "user_cancelled" });
  assert.equal(values.size, 0);
});

test("set tool: validate rejects hostile names and reasons", () => {
  const { store } = fakeStore();
  const tool = makeSetSecretTool(store, async () => "v");
  for (const bad of [null, {}, { name: "has space" }, { name: "-w" }, { name: 42 }]) {
    assert.throws(() => tool.validate(bad));
  }
  assert.throws(() => tool.validate({ name: "OK", reason: "x".repeat(201) }));
  assert.throws(() => tool.validate({ name: "OK", reason: "line1\nline2" }));
  assert.throws(() => tool.validate({ name: "OK", reason: "esc\x1b[31m" }));
  assert.doesNotThrow(() => tool.validate({ name: "OK", reason: "una línea con ñ" }));
});

// ── local_get_secret ─────────────────────────────────────────────────────────

test("get tool: metadata only — the value never crosses", async () => {
  const { store } = fakeStore({ TOKEN: "super-secret-value" });
  await store.set("TOKEN", "super-secret-value"); // stamp it
  const tool = makeGetSecretTool(store);
  assert.equal(tool.permission, "read");
  const res = await tool.run({ name: "TOKEN" });
  assert.equal(res.status, "ok");
  assert.ok(!JSON.stringify(res).includes("super-secret-value"));
  const out = res.status === "ok" ? (res.output as Record<string, unknown>) : {};
  assert.equal(out.exists, true);
  assert.equal(out.backend, "file");

  const missing = await tool.run({ name: "NOPE" });
  assert.deepEqual(missing.status === "ok" && missing.output, { name: "NOPE", exists: false });
});

test("get tool: index drift (metadata without a retrievable value) reads as absent", async () => {
  const { store, values } = fakeStore();
  await store.set("GHOST", "v");
  values.delete("GHOST"); // removed out-of-band; metadata (stamp) remains
  const res = await makeGetSecretTool(store).run({ name: "GHOST" });
  assert.deepEqual(res.status === "ok" && res.output, { name: "GHOST", exists: false });
});

test("get tool: validate rejects hostile names", () => {
  const tool = makeGetSecretTool(fakeStore().store);
  for (const bad of [null, {}, { name: "a b" }, { name: "../x" }]) {
    assert.throws(() => tool.validate(bad));
  }
});
