import test from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  WalletAccessProofCache,
  encodeRecoverableSignature,
  walletAccessBucket,
  walletAccessHashHex,
} from "./wallet-access.js";

const signature = {
  r: `0x${"11".repeat(32)}`,
  s: `0x${"22".repeat(32)}`,
  v: 1,
};

test("wallet access hash is scope, address, and bucket bound", () => {
  const expected = Buffer.from(
    keccak_256(
      new TextEncoder().encode(
        "cowboy-agent-access:0xabcd000000000000000000000000000000000001:42"
      )
    )
  ).toString("hex");
  assert.equal(
    walletAccessHashHex("agent", "0xABCD000000000000000000000000000000000001", 42),
    `0x${expected}`
  );
  assert.notEqual(
    walletAccessHashHex("agent", "0xabcd000000000000000000000000000000000001", 42),
    walletAccessHashHex("conversations", "0xabcd000000000000000000000000000000000001", 42)
  );
});

test("wallet access proof encodes r, s, and v", () => {
  assert.equal(
    encodeRecoverableSignature(signature),
    `0x${"11".repeat(32)}${"22".repeat(32)}01`
  );
  assert.throws(() => encodeRecoverableSignature({ ...signature, r: "0x12" }));
});

test("wallet proof cache signs once per hour bucket", async () => {
  let now = 42 * 3_600_000;
  const hashes: string[] = [];
  const cache = new WalletAccessProofCache(
    "agent",
    "0xabcd000000000000000000000000000000000001",
    async (hash) => {
      hashes.push(hash);
      return signature;
    },
    () => now
  );
  const first = await cache.proof();
  const second = await cache.proof();
  assert.deepEqual(second, first);
  assert.equal(hashes.length, 1);
  now += 3_600_000;
  await cache.proof();
  assert.equal(hashes.length, 2);
  assert.equal(walletAccessBucket(now), 43);
});
