import test from "node:test";
import assert from "node:assert/strict";
import { diffLines } from "./diff.js";

test("diff: identical content reports no changes", () => {
  const d = diffLines("a\nb\nc", "a\nb\nc");
  assert.equal(d.text, "(no changes)");
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
});

test("diff: a single changed line shows - then +", () => {
  const d = diffLines("x = 1\ny = 2\n", "x = 42\ny = 2\n");
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.match(d.text, /- x = 1/);
  assert.match(d.text, /\+ x = 42/);
  assert.match(d.text, /  y = 2/); // unchanged context kept
});

test("diff: a new file (empty before) is all additions", () => {
  const d = diffLines("", "line1\nline2");
  assert.equal(d.removed, 0);
  assert.equal(d.added, 2);
  assert.match(d.text, /\+ line1/);
  assert.match(d.text, /\+ line2/);
});

test("diff: pure insertion keeps surrounding context", () => {
  const d = diffLines("a\nb\nc", "a\nNEW\nb\nc");
  assert.equal(d.added, 1);
  assert.equal(d.removed, 0);
  assert.match(d.text, /\+ NEW/);
});

test("diff: long unchanged runs collapse", () => {
  const before = Array.from({ length: 60 }, (_, i) => `L${i}`).join("\n");
  const after = before.replace("L30", "CHANGED");
  const d = diffLines(before, after);
  assert.match(d.text, /… \d+ unchanged …/);
  assert.match(d.text, /- L30/);
  assert.match(d.text, /\+ CHANGED/);
});

test("diff: a small change in a huge file is shown, not truncated (windowed)", () => {
  const before = Array.from({ length: 2000 }, (_, i) => `L${i}`).join("\n");
  const after = "PREPEND\n" + before; // one added line at the top
  const d = diffLines(before, after);
  assert.equal(d.added, 1);
  assert.equal(d.removed, 0);
  assert.equal(d.truncated, false, "a tiny change needn't truncate a long file");
  assert.match(d.text, /\+ PREPEND/);
  assert.match(d.text, /unchanged …/); // the long tail collapses
});

test("diff: totals reflect the FULL change size on a truncated create (not the head)", () => {
  const after = Array.from({ length: 1000 }, (_, i) => `L${i}`).join("\n");
  const d = diffLines("", after);
  assert.equal(d.added, 1000, "reports all 1000 added lines, not the 800-line window");
  assert.equal(d.removed, 0);
});

test("diff: a huge changed REGION truncates with a note", () => {
  const before = Array.from({ length: 1000 }, (_, i) => `A${i}`).join("\n");
  const after = Array.from({ length: 1000 }, (_, i) => `B${i}`).join("\n"); // every line differs
  const d = diffLines(before, after);
  assert.equal(d.truncated, true);
  assert.match(d.text, /change region longer than \d+ lines/);
});

test("diff: a change past line 800 is still shown (windowed, not hidden)", () => {
  const before = Array.from({ length: 1200 }, (_, i) => `L${i}`).join("\n");
  const after = before.replace("L1000", "CHANGED");
  const d = diffLines(before, after);
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.match(d.text, /- L1000/);
  assert.match(d.text, /\+ CHANGED/);
});

test("diff: overly long lines are clamped", () => {
  const d = diffLines("short", "x".repeat(5000));
  assert.ok(d.text.split("\n").every((l) => l.length <= 210));
  assert.match(d.text, /…/);
});
