import test from "node:test";
import assert from "node:assert/strict";
import { parseSignHashOutput } from "./signer.js";

test("parseSignHashOutput: clean JSON line", () => {
  const sig = parseSignHashOutput('{"r":"0x1","s":"0x2","v":0}');
  assert.deepEqual(sig, { r: "0x1", s: "0x2", v: 0 });
});

test("parseSignHashOutput: ignores warning lines before the JSON", () => {
  const out = "WARNING: signed at protocol-minimum fee\n{\"r\":\"0xaa\",\"s\":\"0xbb\",\"v\":1}\n";
  assert.deepEqual(parseSignHashOutput(out), { r: "0xaa", s: "0xbb", v: 1 });
});

test("parseSignHashOutput: preserves the CLI signer address", () => {
  assert.deepEqual(
    parseSignHashOutput('{"address":"0xabcd","r":"0xaa","s":"0xbb","v":1}'),
    { address: "0xabcd", r: "0xaa", s: "0xbb", v: 1 }
  );
});

test("parseSignHashOutput: throws on no JSON", () => {
  assert.throws(() => parseSignHashOutput("no json here"), /no JSON/);
});

test("parseSignHashOutput: throws on malformed signature", () => {
  assert.throws(() => parseSignHashOutput('{"r":"0x1"}'), /malformed/);
});
