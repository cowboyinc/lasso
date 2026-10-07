import { filesRequestStatement, filesStatementHash } from "./files-authorization.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_RAW_BYTES,
  encodeFilesSignature,
  validateVolumeName,
  validateRemotePath,
  makeFilesClient,
  FilesApiError,
  type UploadFile,
} from "./files-client.js";
import type { EcdsaSignature } from "./signer.js";

// ── helpers ──────────────────────────────────────────────────────────────────

const NOW = 1_800_000_000_000;
const SIG: EcdsaSignature = { r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}`, v: 1 };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeFetch(
  responder: (call: Call, index: number) => { status: number; json?: unknown; text?: string },
  now = () => NOW,
): { calls: Call[]; fetchFn: typeof fetch } {
  const calls: Call[] = [];
  let nonces = 0;
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    if (/\/(files\/authorization|volumes\/challenge)$/.test(String(input))) return Response.json({ nonce: `${now() + 300_000}.${String.fromCharCode(65 + nonces++).repeat(43)}` });
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
  const { calls, fetchFn } = fakeFetch(responder, overrides.now);
  const signCalls: string[] = [];
  const client = makeFilesClient({
    dashboardUrl: "https://dash.example/",
    walletAddress: "0xAbCd000000000000000000000000000000000001",
    fetchFn,
    now: overrides.now ?? (() => NOW),
    signHash:
      overrides.signHash ??
      (async (hashHex: string) => {
        signCalls.push(hashHex);
        return SIG;
      }),
  });
  return { client, calls, signCalls };
}

test("Files request statement includes the selected wallet and request", () => {
  const request = { address: "0xABCD000000000000000000000000000000000001", audience: "https://dash.example", method: "GET", path: "/api/wallet/0xabcd/files", body: undefined, operation: "e0a8ba2a-e1d5-4e47-a8e1-5bdc5d545111" };
  const statement = filesRequestStatement(request, "nonce");
  assert.equal(statement, filesRequestStatement({ ...request, address: request.address.toLowerCase() }, "nonce"));
  assert.notEqual(statement, filesRequestStatement({ ...request, method: "DELETE" }, "nonce"));
  assert.match(filesStatementHash(statement), /^0x[0-9a-f]{64}$/);
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

test("validateRemotePath: rejects traversal, absolute, flag-like and control-char paths", () => {
  assert.doesNotThrow(() => validateRemotePath("actors/counter/main.py"));
  assert.doesNotThrow(() => validateRemotePath("My File.txt"));
  // Control chars included: a newline in a remote path could inject fake
  // lines into the pull approval plan.
  for (const bad of ["", "/abs", "-flag", "a/../b", "a//b", "a/./b", "a\0b", "..", "a\nb", "a\tb", "a\x1b[31mb", " padded.txt", "padded.txt "]) {
    assert.throws(() => validateRemotePath(bad), new RegExp("invalid remote path"));
  }
});

// ── auth header wiring + caching ─────────────────────────────────────────────

test("client: sends request authorization headers and lowercases the address in the URL", async () => {
  const { client, calls } = makeClient(() => ({ status: 200, json: { volumes: [] } }));
  await client.listVolumes();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith("https://dash.example/api/wallet/0xabcd"));
  assert.equal(calls[0].headers["x-cowboy-files-request-sig"], encodeFilesSignature(SIG));
  assert.match(calls[0].headers["x-cowboy-files-request-operation"], /^[0-9a-f-]{36}$/);
  assert.equal(calls[0].headers["x-cowboy-files-ts"], undefined);
});

test("client: authorizes every request with a new signature", async () => {
  let nowMs = NOW;
  const { client, signCalls } = makeClient(() => ({ status: 200, json: { volumes: [] } }), {
    now: () => nowMs,
  });
  await client.listVolumes();
  await client.listVolumes();
  assert.equal(signCalls.length, 2);
  nowMs += 3_600_000; // next hour
  await client.listVolumes();
  assert.equal(signCalls.length, 3);
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

test("readObject: an empty 200 body is an error, never content:'' (no silent blanking)", async () => {
  const fetchFn = (async (input: unknown) => String(input).endsWith("/files/authorization")
    ? Response.json({ nonce: `${NOW + 300_000}.${"a".repeat(43)}` }) :
    ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
      text: async () => "",
    }) as unknown as Response) as unknown as typeof fetch;
  const client = makeFilesClient({
    dashboardUrl: "https://dash.example",
    walletAddress: "0xabcd000000000000000000000000000000000001",
    fetchFn,
    now: () => NOW,
    signHash: async () => SIG,
  });
  await assert.rejects(client.readObject("proj", "a.py"), /empty\/malformed body/);
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

test("client: a transport retry keeps the operation and obtains a fresh authorization", async () => {
  let effects = 0;
  let operation: string | undefined;
  const { client, calls, signCalls } = makeClient(call => {
    if (!operation) {
      operation = call.headers["x-cowboy-files-request-operation"];
      effects++;
      throw new TypeError("response lost");
    }
    assert.equal(call.headers["x-cowboy-files-request-operation"], operation);
    return { status: 200, json: { ok: true } };
  });
  await client.uploadFiles("notes", [{ remote: "a.txt", bytes: Buffer.from("a") }]);
  assert.equal(effects, 1);
  assert.equal(signCalls.length, 2);
  assert.notEqual(signCalls[0], signCalls[1]);
  assert.notEqual(calls[0].headers["x-cowboy-files-request-nonce"], calls[1].headers["x-cowboy-files-request-nonce"]);
  assert.equal(calls[0].body, calls[1].body);
});

test("client: interrupted reauthorization preserves an unconfirmed operation", async () => {
  let calls = 0;
  let signatures = 0;
  const client = makeFilesClient({
    dashboardUrl: "https://dash.example", walletAddress: "0x" + "11".repeat(20), now: () => NOW,
    signHash: async () => { if (++signatures === 2) throw new Error("wallet locked"); return SIG; },
    fetchFn: (async input => {
      if (String(input).endsWith("/files/authorization")) return Response.json({ nonce: `${NOW + 300_000}.${"a".repeat(43)}` });
      calls++;
      throw new TypeError("response lost");
    }) as typeof fetch,
  });
  await assert.rejects(client.uploadFiles("notes", [{ remote: "a.txt", bytes: Buffer.from("a") }]),
    (error: unknown) => error instanceof Error && (error as Error & { uncertain?: boolean }).uncertain === true &&
      typeof (error as Error & { operation?: string }).operation === "string");
  assert.equal(calls, 1);
  assert.equal(signatures, 2);
});
