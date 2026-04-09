import test from "node:test";
import assert from "node:assert/strict";
import { parseInput } from "./LineEditor.js";

test("shift-tab parses as a shifted tab keypress", () => {
  const result = parseInput("\u001B[Z");

  assert.equal(result.key.tab, true);
  assert.equal(result.key.shift, true);
  assert.equal(result.input, "");
});
