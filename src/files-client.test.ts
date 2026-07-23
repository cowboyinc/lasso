import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_RAW_BYTES,
  filesTokenBucket,
  filesTokenHashHex,
  encodeFilesSignature,
  validateVolumeName,
  validateRemotePath,
  makeFilesClient,
  FilesApiError,
  type UploadFile,
} from "./files-client.js";
import type { EcdsaSignature } from "./signer.js";

// ── helpers ──────────────────────────────────────────────────────────────────

const SIG: EcdsaSignature = { r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}`, v: 1 };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeFetch(
  responder: (call: Call, index: number) => { status: number; json?: unknown; text?: string }
): { calls: Call[]; fetchFn: typeof fetch } {
  const calls: Call[] = [];
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const out = responder(call, calls.length - 1);
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      json: async () => out.json ?? {},
      text: async () => out.text ?? "",
    } as Response;
  }) as typeof fetch;
  return { calls, fetchFn };
}

function makeClient(
  responder: Parameters<typeof fakeFetch>[0],
  overrides: { now?: () => number; signHash?: () => Promise<EcdsaSignature> } = {}
) {
  const { calls, fetchFn } = fakeFetch(responder);
  const signCalls: string[] = [];
  const client = makeFilesClient({
    dashboardUrl: "https://dash.example/",
    walletAddress: "0xAbCd000000000000000000000000000000000001",
    fetchFn,
    now: overrides.now ?? (() => 3_600_000 * 1000),
    signHash:
      overrides.signHash ??
      (async (hashHex: string) => {
        signCalls.push(hashHex);
        return SIG;
      }),
  });
  return { client, calls, signCalls };
}

// ── token construction ───────────────────────────────────────────────────────

test("filesTokenHashHex: lowercases the address and binds the bucket", () => {
  const a = filesTokenHashHex("0xABCD000000000000000000000000000000000001", 42);
  const b = filesTokenHashHex("0xabcd000000000000000000000000000000000001", 42);
  const c = filesTokenHashHex("0xabcd000000000000000000000000000000000001", 43);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^0x[0-9a-f]{64}$/);
});

test("filesTokenBucket: floors to the hour", () => {
  assert.equal(filesTokenBucket(3_600_000 * 5 + 3_599_999), 5);
  assert.equal(filesTokenBucket(3_600_000 * 6), 6);
});

test("encodeFilesSignature: 0x || r || s || v wire shape", () => {
  const encoded = encodeFilesSignature(SIG);
  assert.equal(encoded, `0x${"11".repeat(32)}${"22".repeat(32)}01`);
  assert.equal(encoded.length, 2 + 130);
});

test("encodeFilesSignature: rejects malformed components", () => {
  assert.throws(() => encodeFilesSignature({ ...SIG, r: "0x1234" }));
  assert.throws(() => encodeFilesSignature({ ...SIG, s: `0x${"gg".repeat(32)}` }));
  assert.throws(() => encodeFilesSignature({ ...SIG, v: -1 }));
  assert.throws(() => encodeFilesSignature({ ...SIG, v: 1.5 }));
});

// ── input validation ─────────────────────────────────────────────────────────

test("validateVolumeName: accepts CIP-9 names, rejects hostile ones", () => {
  assert.doesNotThrow(() => validateVolumeName("my-project_1.0"));
  for (const bad of ["", "-leading", "a/b", "..", ".", "x".repeat(65), "spa ce"]) {
    assert.throws(() => validateVolumeName(bad), new RegExp("invalid volume name"));
  }
});

test("validateRemotePath: rejects traversal, absolute, flag-like and nul paths", () => {
  assert.doesNotThrow(() => validateRemotePath("actors/counter/main.py"));
  for (const bad of ["", "/abs", "-flag", "a/../b", "a//b", "a/./b", "a\0b", ".."]) {
    assert.throws(() => validateRemotePath(bad), new RegExp("invalid remote path"));
  }
});

// ── auth header wiring + caching ─────────────────────────────────────────────

test("client: sends sig/ts headers and lowercases the address in the URL", async () => {
  const { client, calls } = makeClient(() => ({ status: 200, json: { volumes: [] } }));
  await client.listVolumes();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith("https://dash.example/api/wallet/0xabcd"));
  assert.equal(calls[0].headers["x-cowboy-files-sig"], encodeFilesSignature(SIG));
  assert.equal(calls[0].headers["x-cowboy-files-ts"], String(filesTokenBucket(3_600_000 * 1000)));
});

test("client: caches the token within a bucket, re-signs on bucket change", async () => {
  let nowMs = 3_600_000 * 10;
  const { client, signCalls } = makeClient(() => ({ status: 200, json: { volumes: [] } }), {
    now: () => nowMs,
  });
  await client.listVolumes();
  await client.listVolumes();
  assert.equal(signCalls.length, 1);
  nowMs += 3_600_000; // next hour
  await client.listVolumes();
  assert.equal(signCalls.length, 2);
});

test("client: retries exactly once with a fresh signature on 401", async () => {
  const { client, calls, signCalls } = makeClient((_call, i) =>
    i === 0 ? { status: 401 } : { status: 200, json: { volumes: [] } }
  );
  await client.listVolumes();
  assert.equal(calls.length, 2);
  assert.equal(signCalls.length, 2); // second attempt did not reuse the cache
});

test("client: a second 401 surfaces the friendly auth error (no retry loop)", async () => {
  const { client, calls } = makeClient(() => ({ status: 401 }));
  await assert.rejects(client.listVolumes(), (err: unknown) => {
    assert.ok(err instanceof FilesApiError);
    assert.equal(err.status, 401);
    assert.match(err.message, /wallet signature/);
    return true;
  });
  assert.equal(calls.length, 2);
});

test("client: 409 maps to the CBFS-delegation hint", async () => {
  const { client } = makeClient(() => ({ status: 409 }));
  await assert.rejects(client.createVolume("proj", "public"), /CBFS delegation/);
});

// ── endpoints ────────────────────────────────────────────────────────────────

test("listObjects/readObject: hit the right paths and decode the shapes", async () => {
  const { client, calls } = makeClient((call) => {
    if (call.url.includes("/objects")) {
      return { status: 200, json: { objects: [{ path: "a.py", sizeBytes: 3, mtime: 7 }] } };
    }
    return { status: 200, json: { content: "abc", truncated: false } };
  });
  const objects = await client.listObjects("proj");
  assert.deepEqual(objects, [{ path: "a.py", sizeBytes: 3, mtime: 7 }]);
  const content = await client.readObject("proj", "a.py");
  assert.deepEqual(content, { content: "abc", truncated: false });
  assert.ok(calls[1].url.includes("/files/proj/object?path=a.py"));
});

test("uploadFiles: base64-encodes bytes and posts the batch", async () => {
  const { client, calls } = makeClient(() => ({ status: 200, json: { ok: true } }));
  await client.uploadFiles("proj", [
    { remote: "dir/a.txt", bytes: Buffer.from("hola"), contentType: "text/plain" },
  ]);
  const body = JSON.parse(calls[0].body ?? "{}") as {
    files: Array<{ remote: string; contentBase64: string; contentType?: string }>;
  };
  assert.equal(body.files[0].remote, "dir/a.txt");
  assert.equal(Buffer.from(body.files[0].contentBase64, "base64").toString(), "hola");
  assert.equal(body.files[0].contentType, "text/plain");
});

test("uploadFiles: enforces the batch count and raw-size caps client-side", async () => {
  const { client, calls } = makeClient(() => ({ status: 200, json: { ok: true } }));
  const many: UploadFile[] = Array.from({ length: MAX_UPLOAD_FILES + 1 }, (_, i) => ({
    remote: `f${i}`,
    bytes: Buffer.from("x"),
  }));
  await assert.rejects(client.uploadFiles("proj", many), /max 20/);
  const big: UploadFile[] = [
    { remote: "big", bytes: Buffer.alloc(MAX_UPLOAD_RAW_BYTES + 1) },
  ];
  await assert.rejects(client.uploadFiles("proj", big), /raw bytes/);
  assert.equal(calls.length, 0); // rejected before any network call
});

test("uploadFiles: an empty batch is a no-op (no request, no signing)", async () => {
  const { client, calls, signCalls } = makeClient(() => ({ status: 200, json: { ok: true } }));
  await client.uploadFiles("proj", []);
  assert.equal(calls.length, 0);
  assert.equal(signCalls.length, 0);
});

test("uploadFiles: validates every remote path before sending", async () => {
  const { client, calls } = makeClient(() => ({ status: 200, json: { ok: true } }));
  await assert.rejects(
    client.uploadFiles("proj", [
      { remote: "ok.txt", bytes: Buffer.from("a") },
      { remote: "../escape", bytes: Buffer.from("b") },
    ]),
    /invalid remote path/
  );
  assert.equal(calls.length, 0);
});
