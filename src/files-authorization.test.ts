import test from "node:test";
import assert from "node:assert/strict";
import { authorizeFilesRequest, canonicalFilesBody, canonicalFilesPath, filesRequestStatement, filesStatementHash, type FilesRequest } from "./files-authorization.js";

const NOW = 1_800_000_000_000;
const request: FilesRequest = {
  address: "0xabcd000000000000000000000000000000000001", audience: "https://dash.example:8443", method: "POST",
  path: "/api/wallet/0xabcd000000000000000000000000000000000001/files/notes/upload?z=2&a=one%20two&a=%2B",
  body: { files: [{ remote: "é.txt", contentBase64: "YQ==" }], grant: false },
  operation: "e0a8ba2a-e1d5-4e47-a8e1-5bdc5d545111",
};
const nonce = `${NOW + 300_000}.${"a".repeat(43)}`;
const signature = { r: "0x" + "11".repeat(32), s: "0x" + "22".repeat(32), v: 1 };

test("Files authorization uses the selected context instead of remote signing instructions", async () => {
  const signed: string[] = [];
  const requested: string[] = [];
  const proof = await authorizeFilesRequest(request, {
    now: () => NOW,
    signHash: async hash => { signed.push(hash); return signature; },
    fetchFn: async (url, init) => {
      requested.push(String(url));
      assert.equal(init?.redirect, "error");
      assert.equal(init?.credentials, "omit");
      return Response.json({ nonce, message: "remote statement", bodyHash: "remote hash", audience: "https://other.example" });
    },
  });
  assert.deepEqual(requested, [`${request.audience}/api/wallet/${request.address}/files/authorization`]);
  assert.deepEqual(signed, [filesStatementHash(filesRequestStatement(request, nonce))]);
  assert.equal(proof["x-cowboy-files-request-operation"], request.operation);
  assert.equal(proof["x-cowboy-files-request-nonce"], nonce);
  assert.equal(proof["x-cowboy-files-sig"], undefined);
});

test("Files canonicalization preserves query and body identity across language implementations", () => {
  assert.equal(canonicalFilesBody(request.body), '{"files":[{"contentBase64":"YQ==","remote":"é.txt"}],"grant":false}');
  assert.equal(canonicalFilesPath(request.path), request.path.split("?")[0] + "?a=one+two&a=%2B&z=2");
  assert.equal(canonicalFilesBody({ "😀": 1, "\uE000": 2 }), '{"😀":1,"\uE000":2}');
  assert.equal(canonicalFilesBody({ cert: '{"epoch":18446744073709551615}' }), '{"cert":"{\\"epoch\\":18446744073709551615}"}');
  for (const value of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => canonicalFilesBody(value));
  for (const path of ["https://other.example/a", "//other.example/a", "/a#x", "/a\\b"]) assert.throws(() => canonicalFilesPath(path));
  const statement = filesRequestStatement(request, nonce);
  for (const changed of [
    { address: "0xabcd000000000000000000000000000000000002" }, { audience: "https://other.example" },
    { method: "DELETE" }, { path: request.path + "x" }, { body: { files: [] } },
    { operation: "e0a8ba2a-e1d5-4e47-a8e1-5bdc5d545222" },
  ]) assert.notEqual(filesRequestStatement({ ...request, ...changed }, nonce), statement);
});

for (const invalid of ["unknown", `${NOW}.${"a".repeat(43)}`, `${NOW + 330_001}.${"a".repeat(43)}`]) {
  test(`Files challenge rejects invalid expiry or shape: ${invalid.slice(0, 14)}`, async () => {
    let signatures = 0;
    await assert.rejects(authorizeFilesRequest(request, {
      now: () => NOW, fetchFn: async () => Response.json({ nonce: invalid }),
      signHash: async () => { signatures++; return signature; },
    }), /challenge/);
    assert.equal(signatures, 0);
  });
}

test("request statement matches the shared protocol vector", async () => {
  const { readFileSync } = await import("node:fs");
  const vector = JSON.parse(readFileSync(new URL("./__fixtures__/files-request-v1.json", import.meta.url), "utf8"));
  assert.equal(filesRequestStatement(vector, vector.nonce), vector.statement);
  assert.equal(filesStatementHash(vector.statement).replace(/^0x/, ""), vector.keccak256.replace(/^0x/, ""));
});
