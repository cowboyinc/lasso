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

test("/wallet import --hex routes the secret through stdin (not argv)", () => {
  // The wrapper rewrites the user-facing `--hex <hex>` into the cowboy CLI's
  // `--hex-file -` form and stashes the secret on the `stdin` channel of the
  // result. Argv-based delivery would expose the key via `ps` /
  // `/proc/<pid>/cmdline` for the duration of the subprocess.
  assert.deepEqual(parseCommand("/wallet import --hex 0xabcd"), {
    type: "execute",
    command: "wallet-import-hex",
    args: ["--hex-file", "-"],
    stdin: "0xabcd",
  });

  assert.deepEqual(
    parseCommand("/wallet import --hex 0xabcd --output /tmp/k"),
    {
      type: "execute",
      command: "wallet-import-hex",
      args: ["--hex-file", "-", "--output", "/tmp/k"],
      stdin: "0xabcd",
    },
  );
});

test("/wallet import --hex passes through --force as a bare boolean flag", () => {
  assert.deepEqual(parseCommand("/wallet import --hex 0xabcd --force"), {
    type: "execute",
    command: "wallet-import-hex",
    args: ["--hex-file", "-", "--force"],
    stdin: "0xabcd",
  });

  assert.deepEqual(
    parseCommand("/wallet import --hex 0xabcd --output /tmp/k --force"),
    {
      type: "execute",
      command: "wallet-import-hex",
      args: ["--hex-file", "-", "--output", "/tmp/k", "--force"],
      stdin: "0xabcd",
    },
  );
});

test("/wallet import --mnemonic routes the phrase through stdin (not argv)", () => {
  // Same argv-leak avoidance as the hex branch: the user-facing
  // `--mnemonic <phrase>` becomes cowboy's `--mnemonic-file -` plus a stdin
  // payload that is never visible in `ps` output.
  assert.deepEqual(
    parseCommand('/wallet import --mnemonic "abandon abandon about"'),
    {
      type: "execute",
      command: "wallet-import-mnemonic",
      args: ["--mnemonic-file", "-"],
      stdin: "abandon abandon about",
    },
  );

  assert.deepEqual(
    parseCommand(
      '/wallet import --mnemonic "abandon abandon about" --output /tmp/k --index 3',
    ),
    {
      type: "execute",
      command: "wallet-import-mnemonic",
      args: ["--mnemonic-file", "-", "--output", "/tmp/k", "--index", "3"],
      stdin: "abandon abandon about",
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

test("/init defaults to mesa (cowboy dev network)", () => {
  assert.deepEqual(parseCommand("/init"), {
    type: "execute",
    command: "init",
    args: ["dev"],
  });

  assert.deepEqual(parseCommand("/init mesa"), {
    type: "execute",
    command: "init",
    args: ["dev"],
  });

  assert.deepEqual(parseCommand("/init local"), {
    type: "execute",
    command: "init",
    args: ["local"],
  });

  // The cowboy CLI name for mesa still works.
  assert.deepEqual(parseCommand("/init dev"), {
    type: "execute",
    command: "init",
    args: ["dev"],
  });

  const invalid = parseCommand("/init summit");
  assert.equal(invalid.type, "error");
});

test("/faucet defaults to the session wallet and validates addresses", () => {
  assert.deepEqual(parseCommand("/faucet"), {
    type: "execute",
    command: "faucet",
    args: [],
  });

  assert.deepEqual(parseCommand("/faucet 0x1234567890abcdef1234567890abcdef12345678"), {
    type: "execute",
    command: "faucet",
    args: ["0x1234567890abcdef1234567890abcdef12345678"],
  });

  const invalid = parseCommand("/faucet nonsense");
  assert.equal(invalid.type, "error");
});

test("/walkthrough opens the pager at an optional lesson", () => {
  assert.deepEqual(parseCommand("/walkthrough"), {
    type: "walkthrough",
    lesson: null,
  });

  assert.deepEqual(parseCommand("/walkthrough 3"), {
    type: "walkthrough",
    lesson: 3,
  });

  const invalid = parseCommand("/walkthrough zero");
  assert.equal(invalid.type, "error");
});

test("/docs lists topics or selects one", () => {
  assert.deepEqual(parseCommand("/docs"), { type: "docs", topic: null });
  assert.deepEqual(parseCommand("/docs gas"), { type: "docs", topic: "gas" });
});

test("/permissions shows the mode with no args or `show`", () => {
  assert.deepEqual(parseCommand("/permissions"), { type: "permissions", mode: null });
  assert.deepEqual(parseCommand("/permissions show"), { type: "permissions", mode: null });
  // Singular alias.
  assert.deepEqual(parseCommand("/permission"), { type: "permissions", mode: null });
});

test("/permissions sets a mode via `set <mode>` or the bare shorthand", () => {
  assert.deepEqual(parseCommand("/permissions set auto"), { type: "permissions", mode: "auto" });
  assert.deepEqual(parseCommand("/permissions set default"), { type: "permissions", mode: "default" });
  assert.deepEqual(parseCommand("/permissions auto"), { type: "permissions", mode: "auto" });
  assert.deepEqual(parseCommand("/permissions default"), { type: "permissions", mode: "default" });
});

test("/permissions rejects an unknown mode", () => {
  const bad = parseCommand("/permissions set yolo");
  assert.equal(bad.type, "error");
  assert.match(bad.text, /default\|auto/);
  const bare = parseCommand("/permissions bananas");
  assert.equal(bare.type, "error");
});

test("/permissions appears in slash suggestions", () => {
  assert.ok(
    getSlashCommandSuggestions("/perm").some((item) => item.command === "/permissions")
  );
});
