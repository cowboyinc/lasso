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

test("/wallet export maps to cowboy wallet export", () => {
  assert.deepEqual(parseCommand("/wallet export"), {
    type: "execute",
    command: "wallet-export",
    args: [],
  });

  assert.deepEqual(parseCommand("/wallet export --key /tmp/k"), {
    type: "execute",
    command: "wallet-export",
    args: ["--key", "/tmp/k"],
  });
});

test("/wallet export passes through --no-prefix as a bare boolean flag", () => {
  assert.deepEqual(parseCommand("/wallet export --no-prefix"), {
    type: "execute",
    command: "wallet-export",
    args: ["--no-prefix"],
  });

  assert.deepEqual(parseCommand("/wallet export --key /tmp/k --no-prefix"), {
    type: "execute",
    command: "wallet-export",
    args: ["--key", "/tmp/k", "--no-prefix"],
  });
});

test("/wallet import --hex maps to wallet-import-hex with optional --output", () => {
  assert.deepEqual(
    parseCommand("/wallet import --hex 0xabcd"),
    {
      type: "execute",
      command: "wallet-import-hex",
      args: ["--hex", "0xabcd"],
    },
  );

  assert.deepEqual(
    parseCommand("/wallet import --hex 0xabcd --output /tmp/k"),
    {
      type: "execute",
      command: "wallet-import-hex",
      args: ["--hex", "0xabcd", "--output", "/tmp/k"],
    },
  );
});

test("/wallet import --hex passes through --force as a bare boolean flag", () => {
  assert.deepEqual(
    parseCommand("/wallet import --hex 0xabcd --force"),
    {
      type: "execute",
      command: "wallet-import-hex",
      args: ["--hex", "0xabcd", "--force"],
    },
  );

  assert.deepEqual(
    parseCommand("/wallet import --hex 0xabcd --output /tmp/k --force"),
    {
      type: "execute",
      command: "wallet-import-hex",
      args: ["--hex", "0xabcd", "--output", "/tmp/k", "--force"],
    },
  );
});

test("/wallet import --mnemonic maps to wallet-import-mnemonic with optional flags", () => {
  assert.deepEqual(
    parseCommand('/wallet import --mnemonic "abandon abandon about"'),
    {
      type: "execute",
      command: "wallet-import-mnemonic",
      args: ["--mnemonic", "abandon abandon about"],
    },
  );

  assert.deepEqual(
    parseCommand(
      '/wallet import --mnemonic "abandon abandon about" --output /tmp/k --index 3',
    ),
    {
      type: "execute",
      command: "wallet-import-mnemonic",
      args: ["--mnemonic", "abandon abandon about", "--output", "/tmp/k", "--index", "3"],
    },
  );
});

test("/wallet import without --hex or --mnemonic returns a usage error", () => {
  const result = parseCommand("/wallet import");
  assert.equal(result.type, "error");
  assert.match(result.text, /--hex/);
  assert.match(result.text, /--mnemonic/);
});

test("/wallet import with both --hex and --mnemonic returns an error", () => {
  const result = parseCommand(
    '/wallet import --hex 0xabcd --mnemonic "abandon abandon about"',
  );
  assert.equal(result.type, "error");
  assert.match(result.text, /not both/);
});

test("/wallet export and /wallet import appear in slash suggestions", () => {
  const walletSuggestions = getSlashCommandSuggestions("/wallet").map(
    (item) => item.command,
  );
  assert.ok(walletSuggestions.includes("/wallet export"));
  assert.ok(walletSuggestions.includes("/wallet import"));
});
