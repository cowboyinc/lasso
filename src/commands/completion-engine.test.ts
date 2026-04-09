import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompletionCache, getCompletionResult } from "./autocomplete.js";
import type { SessionState } from "../types.js";

function createSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    validatorUrl: "http://localhost:4000",
    dashboardUrl: null,
    walletAddress: null,
    actors: [],
    feeds: [],
    ...overrides,
  };
}

test("returns command candidates from schema literals", async () => {
  const result = await getCompletionResult({
    input: "actor ",
    cursorOffset: 6,
    cwd: process.cwd(),
    session: createSession(),
    cache: new CompletionCache(),
  });

  assert.deepEqual(result?.items.map((item) => item.value), [
    "deploy",
    "execute",
    "get",
    "address",
    "new",
    "label",
    "list",
    "logs",
  ]);
  assert.equal(result?.items[0]?.kind, "command");
});

test("returns static flag candidates from schema", async () => {
  const result = await getCompletionResult({
    input: "actor get --a",
    cursorOffset: 13,
    cwd: process.cwd(),
    session: createSession(),
    cache: new CompletionCache(),
  });

  assert.deepEqual(result?.items.map((item) => item.value), ["--address"]);
  assert.equal(result?.items[0]?.kind, "flag");
});

test("returns static flag candidates when a command is fully resolved", async () => {
  const result = await getCompletionResult({
    input: "transfer ",
    cursorOffset: 9,
    cwd: process.cwd(),
    session: createSession(),
    cache: new CompletionCache(),
  });

  assert.deepEqual(result?.items.map((item) => item.value), ["--to", "--amount"]);
  assert.equal(result?.items[0]?.kind, "flag");
});

test("returns path candidates for path arguments", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lasso-complete-"));
  mkdirSync(join(cwd, "actors"));
  mkdirSync(join(cwd, "actors", "nested"));
  writeFileSync(join(cwd, "actors", "hello.py"), "");
  writeFileSync(join(cwd, "actors", "helper.txt"), "");

  const result = await getCompletionResult({
    input: "actor deploy actors/h",
    cursorOffset: 21,
    cwd,
    session: createSession(),
    cache: new CompletionCache(),
  });

  assert.deepEqual(result?.items.map((item) => item.value), ["actors/hello.py", "actors/helper.txt"]);
  assert.equal(result?.items[0]?.kind, "path");
});

test("returns directory path candidates with a trailing slash", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lasso-complete-dir-"));
  mkdirSync(join(cwd, "actors"));
  mkdirSync(join(cwd, "actors", "nested"));

  const result = await getCompletionResult({
    input: "actor deploy actors/n",
    cursorOffset: 21,
    cwd,
    session: createSession(),
    cache: new CompletionCache(),
  });

  assert.deepEqual(result?.items.map((item) => item.value), ["actors/nested/"]);
  assert.equal(result?.items[0]?.detail, "directory");
});

test("skips unsafe path candidates that would alter tokenization", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lasso-complete-safe-"));
  mkdirSync(join(cwd, "actors"));
  writeFileSync(join(cwd, "actors", "safe.py"), "");
  writeFileSync(join(cwd, "actors", "--payload.py"), "");
  writeFileSync(join(cwd, "actors", "quo\"te.py"), "");
  writeFileSync(join(cwd, "actors", "apo's.py"), "");

  const result = await getCompletionResult({
    input: "actor deploy actors/",
    cursorOffset: 20,
    cwd,
    session: createSession(),
    cache: new CompletionCache(),
  });

  assert.deepEqual(result?.items.map((item) => item.value), ["actors/safe.py"]);
});

test("returns path candidates from within a completed subdirectory", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lasso-complete-subdir-"));
  mkdirSync(join(cwd, "actors"));
  mkdirSync(join(cwd, "actors", "nested"));
  writeFileSync(join(cwd, "actors", "nested", "main.py"), "");
  writeFileSync(join(cwd, "actors", "nested", "helper.py"), "");

  const result = await getCompletionResult({
    input: "actor deploy actors/nested/",
    cursorOffset: 27,
    cwd,
    session: createSession(),
    cache: new CompletionCache(),
  });

  assert.deepEqual(result?.items.map((item) => item.value), [
    "actors/nested/helper.py",
    "actors/nested/main.py",
  ]);
  assert.equal(result?.items[0]?.kind, "path");
});

test("returns actor candidates from tracked session state", async () => {
  const result = await getCompletionResult({
    input: "actor execute ",
    cursorOffset: 14,
    cwd: process.cwd(),
    session: createSession({
      actors: [
        { address: "0xabc", label: "alpha" },
        { address: "0xdef", label: "beta" },
      ],
    }),
    cache: new CompletionCache(),
  });

  assert.deepEqual(result?.items.map((item) => item.value), ["0xabc", "0xdef"]);
  assert.equal(result?.items[0]?.label, "alpha");
  assert.equal(result?.items[0]?.kind, "actor");
});

test("returns actor candidates for actor get positional address", async () => {
  const result = await getCompletionResult({
    input: "actor get ",
    cursorOffset: 10,
    cwd: process.cwd(),
    session: createSession({
      actors: [
        { address: "0xabc", label: "alpha" },
        { address: "0xdef", label: "beta" },
      ],
    }),
    cache: new CompletionCache(),
  });

  assert.deepEqual(result?.items.map((item) => item.value), ["0xabc", "0xdef"]);
  assert.equal(result?.items[0]?.kind, "actor");
});

test("returns actor candidates for actor logs positional address", async () => {
  const result = await getCompletionResult({
    input: "actor logs ",
    cursorOffset: 11,
    cwd: process.cwd(),
    session: createSession({
      actors: [
        { address: "0xabc", label: "alpha" },
        { address: "0xdef", label: "beta" },
      ],
    }),
    cache: new CompletionCache(),
  });

  assert.deepEqual(result?.items.map((item) => item.value), ["0xabc", "0xdef"]);
  assert.equal(result?.items[0]?.kind, "actor");
});

test("returns token subcommands including launch", async () => {
  const result = await getCompletionResult({
    input: "token ",
    cursorOffset: 6,
    cwd: process.cwd(),
    session: createSession(),
    cache: new CompletionCache(),
  });

  assert.equal(result?.items.some((item) => item.value === "launch"), true);
});

test("returns feed candidates from tracked session state", async () => {
  const result = await getCompletionResult({
    input: "watchtower feed ",
    cursorOffset: 16,
    cwd: process.cwd(),
    session: createSession({
      feeds: [
        { id: "feed-1", name: "BTC Price" },
        { id: "feed-2", name: "ETH Price" },
      ],
    }),
    cache: new CompletionCache(),
  });

  assert.deepEqual(result?.items.map((item) => item.value), ["feed-1", "feed-2"]);
  assert.equal(result?.items[0]?.label, "BTC Price");
  assert.equal(result?.items[0]?.kind, "feed");
});

test("reuses cached provider results until invalidated", async () => {
  let calls = 0;
  const cache = new CompletionCache();

  const context = {
    input: "watchtower feed ",
    cursorOffset: 16,
    cwd: process.cwd(),
    session: createSession(),
    cache,
    providers: {
      feed: async () => {
        calls++;
        return [{ value: "feed-1", label: "BTC Price", kind: "feed" as const }];
      },
    },
  };

  await getCompletionResult(context);
  await getCompletionResult(context);
  assert.equal(calls, 1);

  cache.invalidate("feed");

  await getCompletionResult(context);
  assert.equal(calls, 2);
});

test("path completions reflect filesystem changes across repeated lookups", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lasso-complete-refresh-"));
  mkdirSync(join(cwd, "actors"));
  writeFileSync(join(cwd, "actors", "alpha.py"), "");
  const cache = new CompletionCache();

  const first = await getCompletionResult({
    input: "actor deploy actors/",
    cursorOffset: 20,
    cwd,
    session: createSession(),
    cache,
  });

  assert.deepEqual(first?.items.map((item) => item.value), ["actors/alpha.py"]);

  writeFileSync(join(cwd, "actors", "beta.py"), "");

  const second = await getCompletionResult({
    input: "actor deploy actors/",
    cursorOffset: 20,
    cwd,
    session: createSession(),
    cache,
  });

  assert.deepEqual(second?.items.map((item) => item.value), [
    "actors/alpha.py",
    "actors/beta.py",
  ]);
});

test("returns null when no route or provider applies", async () => {
  const result = await getCompletionResult({
    input: "unknown command",
    cursorOffset: 15,
    cwd: process.cwd(),
    session: createSession(),
    cache: new CompletionCache(),
  });

  assert.equal(result, null);
});
