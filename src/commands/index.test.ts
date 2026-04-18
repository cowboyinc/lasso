import test from "node:test";
import assert from "node:assert/strict";
import { getSlashCommandSuggestions, parseCommand } from "./index.js";

test("plain text input is routed as an AI prompt", () => {
  assert.deepEqual(parseCommand("build me a counter actor"), {
    type: "prompt",
    text: "build me a counter actor",
  });
});

test("slash commands stay local", () => {
  assert.deepEqual(parseCommand("/actor deploy actors/hello/main.py"), {
    type: "execute",
    command: "deploy-actor",
    args: ["actors/hello/main.py"],
  });
});

test("runner preference commands accept auto and explicit addresses", () => {
  assert.deepEqual(parseCommand("/runner primary auto"), {
    type: "execute",
    command: "runner-primary",
    args: ["auto"],
  });

  assert.deepEqual(parseCommand("/runner helper 0x1234567890abcdef1234567890abcdef12345678"), {
    type: "execute",
    command: "runner-helper",
    args: ["0x1234567890abcdef1234567890abcdef12345678"],
  });
});

test("job commands require a job id and parse flags", () => {
  assert.deepEqual(parseCommand("/job status --job-id 0xabc"), {
    type: "execute",
    command: "job-status",
    args: ["0xabc"],
  });

  assert.deepEqual(parseCommand("/job results 0xdef"), {
    type: "execute",
    command: "job-results",
    args: ["0xdef"],
  });
});

test("help documents the slash-command and AI split", () => {
  const result = parseCommand("/help");
  assert.equal(result.type, "output");
  assert.match(result.text, /Plain text submits an AI job to the runner network\./);
  assert.match(result.text, /Every local command starts with \//);
});

test("slash suggestions are alphabetical and filter by prefix", () => {
  const all = getSlashCommandSuggestions("/");
  assert.ok(all.length > 10);
  assert.deepEqual(
    all.map((item) => item.command),
    [...all.map((item) => item.command)].sort((a, b) => a.localeCompare(b))
  );

  const filtered = getSlashCommandSuggestions("/runner");
  assert.deepEqual(
    filtered.map((item) => item.command),
    [
      "/runner get",
      "/runner helper",
      "/runner list",
      "/runner primary",
      "/runner register",
    ]
  );

  assert.deepEqual(
    getSlashCommandSuggestions("/r p").map((item) => item.command),
    ["/runner primary"]
  );

  assert.ok(
    getSlashCommandSuggestions("/n f").some((item) => item.command === "/watchtower new feed")
  );
});
