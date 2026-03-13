import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tokenizeWithSpans, findTokenAtCursor } from "./autocomplete/parser.js";
import { getSpecCursorState } from "./autocomplete/matcher.js";
import { pathProvider } from "./autocomplete/providers.js";
import { COMMAND_SPECS } from "./schema.js";
import { CompletionCache } from "./autocomplete.js";

test("tokenizeWithSpans preserves quoted values without quote characters", () => {
  const tokens = tokenizeWithSpans(`actor label 0xabc "hello world"`);

  assert.deepEqual(tokens, [
    { value: "actor", start: 0, end: 5 },
    { value: "label", start: 6, end: 11 },
    { value: "0xabc", start: 12, end: 17 },
    { value: "hello world", start: 18, end: 31 },
  ]);
});

test("findTokenAtCursor returns the current token prefix and previous tokens", () => {
  const input = "actor get --add";
  const tokens = tokenizeWithSpans(input);

  assert.deepEqual(findTokenAtCursor(input, tokens, input.length), {
    tokenStart: 10,
    tokenEnd: 15,
    prefix: "--add",
    previousTokens: ["actor", "get"],
  });
});

test("getSpecCursorState returns flag candidates after a fully resolved command", () => {
  const spec = COMMAND_SPECS.find((candidate) => candidate.parserKey === "transfer");
  assert.ok(spec);

  assert.deepEqual(getSpecCursorState(spec, []), {
    kind: "literal",
    items: [{ value: "transfer", label: "transfer", detail: spec.summary, kind: "command" }],
  });

  assert.deepEqual(getSpecCursorState(spec, ["transfer"]), {
    kind: "flag",
    items: [
      { value: "--to", label: "--to", detail: "Destination address", kind: "flag" },
      { value: "--amount", label: "--amount", detail: "Amount in CBY", kind: "flag" },
    ],
  });
});

test("pathProvider returns directory entries with directory suffixes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lasso-provider-"));
  mkdirSync(join(cwd, "actors"));
  mkdirSync(join(cwd, "actors", "nested"));
  writeFileSync(join(cwd, "actors", "hello.py"), "");

  const items = await pathProvider({
    prefix: "actors/",
    cwd,
    session: {
      validatorUrl: "http://localhost:4000",
      walletAddress: null,
      actors: [],
      feeds: [],
    },
    cache: new CompletionCache(),
  });

  assert.deepEqual(items, [
    { value: "actors/hello.py", label: "actors/hello.py", detail: undefined, kind: "path" },
    { value: "actors/nested/", label: "actors/nested/", detail: "directory", kind: "path" },
  ]);
});

test("pathProvider prevents traversal outside the cwd", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lasso-provider-traversal-"));
  writeFileSync(join(dirname(cwd), "secret.txt"), "");

  const items = await pathProvider({
    prefix: "../",
    cwd,
    session: {
      validatorUrl: "http://localhost:4000",
      walletAddress: null,
      actors: [],
      feeds: [],
    },
    cache: new CompletionCache(),
  });

  assert.deepEqual(items, []);
});

test("pathProvider skips entries that disappear during metadata lookup", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lasso-provider-race-"));
  mkdirSync(join(cwd, "actors"));
  writeFileSync(join(cwd, "actors", "good.txt"), "");
  symlinkSync("/nonexistent-target", join(cwd, "actors", "broken"));

  const items = await pathProvider({
    prefix: "actors/",
    cwd,
    session: {
      validatorUrl: "http://localhost:4000",
      walletAddress: null,
      actors: [],
      feeds: [],
    },
    cache: new CompletionCache(),
  });

  assert.deepEqual(items, [
    { value: "actors/good.txt", label: "actors/good.txt", detail: undefined, kind: "path" },
  ]);
});
