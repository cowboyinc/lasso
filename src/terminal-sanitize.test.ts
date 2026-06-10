import test from "node:test";
import assert from "node:assert/strict";
import { stripTerminalControl } from "./terminal-sanitize.js";

test("strips CSI color/cursor sequences", () => {
  assert.equal(stripTerminalControl("a\x1b[31mred\x1b[0m b\x1b[2Ac"), "ared bc");
});

test("strips OSC title and clipboard writes (BEL and ST terminated)", () => {
  assert.equal(stripTerminalControl("x\x1b]0;evil title\x07y"), "xy");
  assert.equal(stripTerminalControl("x\x1b]52;c;ZXZpbA==\x1b\\y"), "xy");
});

test("swallows an unterminated OSC from a streaming partial", () => {
  assert.equal(stripTerminalControl("safe\x1b]52;c;ZXZpb"), "safe");
});

test("preserves newlines, tabs, and plain markdown", () => {
  assert.equal(
    stripTerminalControl("### head\n- a\tb\n`code`"),
    "### head\n- a\tb\n`code`"
  );
});

test("drops carriage returns and other C0 controls", () => {
  assert.equal(stripTerminalControl("a\rb\x00c\x08d"), "abcd");
});
