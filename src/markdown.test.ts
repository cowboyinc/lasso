import test from "node:test";
import assert from "node:assert/strict";
import { parseInline, parseMarkdown } from "./markdown.js";

test("parseInline: bold, italic, code, and plain segments", () => {
  assert.deepEqual(parseInline("a **b** *c* _d_ `e` f"), [
    { style: "plain", text: "a " },
    { style: "bold", text: "b" },
    { style: "plain", text: " " },
    { style: "italic", text: "c" },
    { style: "plain", text: " " },
    { style: "italic", text: "d" },
    { style: "plain", text: " " },
    { style: "code", text: "e" },
    { style: "plain", text: " f" },
  ]);
});

test("parseInline: double asterisks parse as bold, not italic", () => {
  assert.deepEqual(parseInline("**bold**"), [{ style: "bold", text: "bold" }]);
});

test("parseInline: spaced asterisks are not italics", () => {
  assert.deepEqual(parseInline("2 * 3 * 4"), [
    { style: "plain", text: "2 * 3 * 4" },
  ]);
});

test("parseMarkdown: headings carry level and inline styles", () => {
  assert.deepEqual(parseMarkdown("### Total **Fee** Formula"), [
    {
      kind: "heading",
      level: 3,
      spans: [
        { style: "plain", text: "Total " },
        { style: "bold", text: "Fee" },
        { style: "plain", text: " Formula" },
      ],
    },
  ]);
});

test("parseMarkdown: bullets and ordered items keep indent and number", () => {
  assert.deepEqual(parseMarkdown("- one\n  - nested\n3. third"), [
    { kind: "bullet", indent: 0, spans: [{ style: "plain", text: "one" }] },
    { kind: "bullet", indent: 2, spans: [{ style: "plain", text: "nested" }] },
    { kind: "ordered", indent: 0, number: "3", spans: [{ style: "plain", text: "third" }] },
  ]);
});

test("parseMarkdown: quotes and horizontal rules", () => {
  assert.deepEqual(parseMarkdown("> note\n---"), [
    { kind: "quote", spans: [{ style: "plain", text: "note" }] },
    { kind: "hr" },
  ]);
});

test("parseMarkdown: fenced code passes through unparsed", () => {
  assert.deepEqual(parseMarkdown("```python\n- not a bullet\n```"), [
    { kind: "code", lines: ["- not a bullet"] },
  ]);
});

test("parseMarkdown: unclosed fence flushes as code (mid-stream)", () => {
  assert.deepEqual(parseMarkdown("text\n```\ncode so far"), [
    { kind: "paragraph", spans: [{ style: "plain", text: "text" }] },
    { kind: "code", lines: ["code so far"] },
  ]);
});

test("parseMarkdown: consecutive blanks collapse, trailing blanks trimmed", () => {
  assert.deepEqual(parseMarkdown("a\n\n\n\nb\n\n"), [
    { kind: "paragraph", spans: [{ style: "plain", text: "a" }] },
    { kind: "blank" },
    { kind: "paragraph", spans: [{ style: "plain", text: "b" }] },
  ]);
});

test("parseInline: snake_case identifiers are not italics", () => {
  assert.deepEqual(parseInline("use max_fee_per_gas and get_count here"), [
    { style: "plain", text: "use max_fee_per_gas and get_count here" },
  ]);
});
