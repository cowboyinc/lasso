import test from "node:test";
import assert from "node:assert/strict";
import { isNewerVersion } from "./update-check.js";

test("isNewerVersion compares semver correctly", () => {
  assert.equal(isNewerVersion("0.3.5", "0.3.4"), true);
  assert.equal(isNewerVersion("v0.3.5", "0.3.4"), true);
  assert.equal(isNewerVersion("0.4.0", "0.3.9"), true);
  assert.equal(isNewerVersion("1.0.0", "0.9.9"), true);
  assert.equal(isNewerVersion("0.3.4", "0.3.4"), false);
  assert.equal(isNewerVersion("0.3.3", "0.3.4"), false);
  assert.equal(isNewerVersion("0.3.10", "0.3.9"), true);
  assert.equal(isNewerVersion("garbage", "0.3.4"), false);
  assert.equal(isNewerVersion("0.3.5", "garbage"), false);
});
