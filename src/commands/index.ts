import type { CommandResult } from "../types.js";

export interface SlashCommandSuggestion {
  command: string;
  description: string;
}

const RAW_SLASH_COMMAND_CATALOG: SlashCommandSuggestion[] = [
  { command: "/actor address", description: "Derive an actor address from code, creator, and salt" },
  { command: "/actor deploy", description: "Deploy an actor to the chain" },
  { command: "/actor execute", description: "Execute an actor handler" },
  { command: "/actor get", description: "Get actor details" },
  { command: "/actor label", description: "Set a label for an actor" },
  { command: "/actor list", description: "List deployed actors" },
  { command: "/actor logs", description: "View actor logs" },
  { command: "/actor new", description: "Scaffold a new actor project" },
  { command: "/clear", description: "Clear the console" },
  { command: "/deploy actor", description: "Deploy an actor from the short alias" },
  { command: "/exit", description: "Quit lasso" },
  { command: "/help", description: "Show available commands" },
  { command: "/docs", description: "Browse bundled Cowboy reference docs" },
  { command: "/faucet", description: "Request devnet CBY from the faucet" },
  { command: "/init", description: "Initialize a project on mesa (default) or a local node" },
  { command: "/permissions", description: "View or set the approval mode (default|auto)" },
  { command: "/walkthrough", description: "Guided tour of how Cowboy works" },
  { command: "/job results", description: "Get raw job results" },
  { command: "/job runners", description: "Show runners observed for a job" },
  { command: "/job status", description: "Check job status" },
  { command: "/job verified", description: "Get the verified result for a job" },
  { command: "/runner get", description: "Get runner details" },
  { command: "/runner helper", description: "Set the helper runner preference" },
  { command: "/runner list", description: "List active runners and routing hints" },
  { command: "/runner primary", description: "Set the primary runner preference" },
  { command: "/runner register", description: "Register this wallet as a runner" },
  { command: "/simulate", description: "Run an actor handler locally against the PVM (advisory)" },
  { command: "/secrets set", description: "Store a secret locally (masked input; never leaves this machine)" },
  { command: "/secrets list", description: "List local secret names (values are never shown)" },
  { command: "/secrets delete", description: "Remove a local secret" },
  { command: "/sync push", description: "Upload project files to the wallet's CBFS volume" },
  { command: "/sync pull", description: "Download the CBFS volume into the local project" },
  { command: "/token approve", description: "Approve a token spender" },
  { command: "/token balance", description: "Check a token balance" },
  { command: "/token burn", description: "Burn tokens" },
  { command: "/token create", description: "Create a token" },
  { command: "/token info", description: "Show token metadata" },
  { command: "/token launch", description: "Open the token launch wizard" },
  { command: "/token list", description: "List tokens on chain" },
  { command: "/token mint", description: "Mint tokens" },
  { command: "/token transfer", description: "Transfer tokens" },
  { command: "/transfer", description: "Transfer CBY to an address" },
  { command: "/wallet address", description: "Show wallet address" },
  { command: "/wallet balance", description: "Show wallet balance" },
  { command: "/wallet create", description: "Generate a new keypair" },
  { command: "/wallet export", description: "Export the private key as hex" },
  { command: "/wallet import", description: "Import a wallet from hex or mnemonic" },
  { command: "/watchtower feed", description: "Publish to or inspect a feed" },
  { command: "/watchtower feeds", description: "List feeds" },
  { command: "/watchtower list", description: "List watchtower resources" },
  { command: "/watchtower new feed", description: "Create a new feed" },
];

export const SLASH_COMMAND_CATALOG = [...RAW_SLASH_COMMAND_CATALOG].sort((a, b) =>
  a.command.localeCompare(b.command)
);

function matchesSlashCommandQuery(command: string, query: string): boolean {
  const commandWords = command.slice(1).toLowerCase().split(/\s+/);
  const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean);

  if (queryWords.length === 0) {
    return true;
  }

  let commandIndex = 0;
  for (const token of queryWords) {
    let matched = false;

    while (commandIndex < commandWords.length) {
      if (commandWords[commandIndex].startsWith(token)) {
        matched = true;
        commandIndex++;
        break;
      }
      commandIndex++;
    }

    if (!matched) {
      return false;
    }
  }

  return true;
}

export function getSlashCommandSuggestions(
  input: string,
  limit = SLASH_COMMAND_CATALOG.length
): SlashCommandSuggestion[] {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) {
    return [];
  }

  const query = trimmed.slice(1).trim().toLowerCase();
  if (query.length === 0) {
    return SLASH_COMMAND_CATALOG.slice(0, limit);
  }

  const queryWords = query.split(/\s+/).filter(Boolean);
  let matches: SlashCommandSuggestion[];

  if (queryWords.length === 1) {
    const token = queryWords[0];
    const topLevelMatches = SLASH_COMMAND_CATALOG.filter((item) =>
      item.command.slice(1).toLowerCase().split(/\s+/)[0]?.startsWith(token)
    );

    matches = topLevelMatches.length > 0
      ? topLevelMatches
      : SLASH_COMMAND_CATALOG.filter((item) =>
          item.command.slice(1).toLowerCase().split(/\s+/).some((word) => word.startsWith(token))
        );
  } else {
    matches = SLASH_COMMAND_CATALOG.filter((item) =>
      matchesSlashCommandQuery(item.command, query)
    );
  }

  return matches.slice(0, limit);
}

function parseFlags(parts: string[]): {
  flags: Record<string, string>;
  positional: string[];
} {
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  let i = 0;
  while (i < parts.length) {
    if (parts[i].startsWith("--") && i + 1 < parts.length) {
      flags[parts[i].slice(2)] = parts[i + 1];
      i += 2;
    } else {
      positional.push(parts[i]);
      i++;
    }
  }
  return { flags, positional };
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (current) tokens.push(current);
  return tokens;
}

export function parseCommand(input: string): CommandResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { type: "output", text: "" };
  }

  if (!trimmed.startsWith("/")) {
    return { type: "prompt", text: trimmed };
  }

  const normalized = trimmed.slice(1).trim();
  if (!normalized) {
    return { type: "output", text: "" };
  }

  const parts = tokenize(normalized);
  const command = parts[0].toLowerCase();

  switch (command) {
    case "help":
      return handleHelp();

    case "clear":
      return { type: "clear" };

    case "exit":
    case "quit":
      return { type: "quit" };

    case "init": {
      // Default to mesa, the public devnet. "mesa" is the public name for
      // what the cowboy CLI calls "dev".
      const env = parts[1]?.toLowerCase() ?? "mesa";
      const network = env === "mesa" ? "dev" : env;
      if (!["dev", "local"].includes(network)) {
        return { type: "error", text: "Usage: /init [mesa|local]  (defaults to mesa, the public devnet)" };
      }
      return { type: "execute", command: "init", args: [network] };
    }

    case "deploy": {
      if (parts[1]?.toLowerCase() === "actor") {
        const filePath = parts.slice(2).join(" ");
        if (!filePath) {
          return { type: "error", text: "Usage: /deploy actor <file_path>" };
        }
        return { type: "execute", command: "deploy-actor", args: [filePath] };
      }
      return {
        type: "error",
        text: `Unknown deploy target: ${parts[1] || "(none)"}. Usage: /deploy actor <file>`,
      };
    }

    case "actor":
      return parseActorCommand(parts);

    case "runner":
      return parseRunnerCommand(parts);

    case "job":
      return parseJobCommand(parts);

    case "faucet": {
      const address = parts[1];
      if (address && !/^(0x)?[a-fA-F0-9]{40}$/.test(address)) {
        return { type: "error", text: `Invalid address: ${address}. Usage: /faucet [address]` };
      }
      return { type: "execute", command: "faucet", args: address ? [address] : [] };
    }

    case "simulate": {
      const { flags, positional } = parseFlags(parts.slice(1));
      // Prefer explicit flags; only consume a positional for a slot a flag
      // didn't fill, so `--actor x --handler get 0x7b7d` still reads 0x7b7d as
      // the payload (positional[0]) instead of dropping it.
      let pi = 0;
      const take = (flagVal: string | undefined): string | undefined =>
        flagVal !== undefined ? flagVal : positional[pi++];
      const file = take(flags.actor);
      const handler = take(flags.handler);
      const payload = take(flags.payload);
      if (!file || !handler) {
        return {
          type: "error",
          text: "Usage: /simulate <file> <handler> [payload_hex]",
        };
      }
      const args = [file, handler];
      if (payload) args.push(payload);
      return { type: "execute", command: "simulate", args };
    }

    case "secrets": {
      const sub = parts[1];
      const name = parts[2];
      if (sub === "list") {
        if (parts.length > 2) {
          return {
            type: "error",
            text: "Usage: /secrets list (no extra arguments — if you pasted a value, treat it as exposed and rotate it).",
          };
        }
        return { type: "execute", command: "secrets-list", args: [] };
      }
      if (sub !== "set" && sub !== "delete") {
        return { type: "error", text: "Usage: /secrets set|delete <NAME> | /secrets list" };
      }
      // A surplus token or NAME=value is almost certainly a secret typed
      // inline — it is ALREADY visible in the console log above. Never echo
      // any token back (that would duplicate the leak); tell the user how to
      // clean up instead.
      if (parts.length > 3 || (name !== undefined && name.includes("="))) {
        return {
          type: "error",
          text:
            "Never put the secret VALUE on the command line. The line was redacted from the console log and history, " +
            "but treat the value as exposed anyway (it was on screen) — rotate it if it was real. " +
            "Use /secrets set <NAME> and type the value in the masked prompt.",
        };
      }
      if (!name || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
        return {
          type: "error",
          text: "Invalid secret name (use [A-Za-z_][A-Za-z0-9_], max 64). The VALUE is asked with a masked prompt — never put it on the command line.",
        };
      }
      return { type: "execute", command: `secrets-${sub}`, args: [name] };
    }

    case "sync": {
      const sub = parts[1];
      const volume = parts[2];
      if (sub !== "push" && sub !== "pull") {
        return { type: "error", text: "Usage: /sync push|pull [volume]" };
      }
      if (volume !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(volume)) {
        return { type: "error", text: `Invalid volume name: ${volume}. Usage: /sync push|pull [volume]` };
      }
      return { type: "execute", command: `sync-${sub}`, args: volume ? [volume] : [] };
    }

    case "walkthrough": {
      const lesson = parts[1] ? Number(parts[1]) : null;
      if (parts[1] && (!Number.isInteger(lesson) || lesson! < 1)) {
        return { type: "error", text: "Usage: /walkthrough [lesson number]" };
      }
      return { type: "walkthrough", lesson };
    }

    case "docs": {
      const topic = parts.slice(1).join(" ").toLowerCase() || null;
      return { type: "docs", topic };
    }

    case "permission":
    case "permissions": {
      const sub = parts[1]?.toLowerCase();
      if (!sub || sub === "show") {
        return { type: "permissions", mode: null };
      }
      // Accept both `/permissions set auto` and the shorthand `/permissions auto`.
      const target = sub === "set" ? parts[2]?.toLowerCase() : sub;
      if (target === "default" || target === "auto") {
        return { type: "permissions", mode: target };
      }
      return {
        type: "error",
        text: "Usage: /permissions [show | set <default|auto>]",
      };
    }

    case "transfer": {
      const { flags } = parseFlags(parts.slice(1));
      if (!flags.to || !flags.amount) {
        return { type: "error", text: "Usage: /transfer --to <address> --amount <cby>" };
      }
      return { type: "execute", command: "transfer", args: ["--to", flags.to, "--amount", flags.amount] };
    }

    case "wallet":
      return parseWalletCommand(parts);

    case "token":
      return parseTokenCommand(parts);

    case "watchtower":
      return parseWatchtowerCommand(parts);

    default:
      return {
        type: "error",
        text: `Unknown command: ${trimmed}. Type /help for available commands.`,
      };
  }
}

function parseActorCommand(parts: string[]): CommandResult {
  const sub = parts[1]?.toLowerCase();
  const rest = parts.slice(2);

  switch (sub) {
    case "deploy": {
      const filePath = rest.join(" ");
      if (!filePath) {
        return { type: "error", text: "Usage: /actor deploy <file_path>" };
      }
      return { type: "execute", command: "deploy-actor", args: [filePath] };
    }

    case "execute": {
      const { flags, positional } = parseFlags(rest);
      const actor = flags.actor ?? positional[0];
      const handler = flags.handler ?? positional[1];
      if (!actor || !handler) {
        return {
          type: "error",
          text: "Usage: /actor execute <address> <method> [--payload <json>]",
        };
      }
      const payload = flags.payload ?? "7b7d";
      const cyclesLimit = flags["cycles-limit"] ?? "500000";
      const cellsLimit = flags["cells-limit"] ?? "500000";
      const args = [
        "--actor", actor,
        "--handler", handler,
        "--payload", payload,
        "--cycles-limit", cyclesLimit,
        "--cells-limit", cellsLimit,
      ];
      return { type: "execute", command: "actor-execute", args };
    }

    case "get": {
      const { flags, positional } = parseFlags(rest);
      const address = flags.address ?? positional[0];
      if (!address) {
        return { type: "error", text: "Usage: /actor get <address>" };
      }
      return { type: "execute", command: "actor-get", args: ["--address", address] };
    }

    case "address": {
      const { flags } = parseFlags(rest);
      if (!flags.code || !flags.creator || !flags.salt) {
        return {
          type: "error",
          text: "Usage: /actor address --code <file> --creator <address> --salt <hex>",
        };
      }
      return {
        type: "execute",
        command: "actor-address",
        args: ["--code", flags.code, "--creator", flags.creator, "--salt", flags.salt],
      };
    }

    case "new": {
      const name = rest[0];
      if (!name) {
        return { type: "error", text: "Usage: /actor new <name>" };
      }
      return { type: "execute", command: "actor-new", args: [name] };
    }

    case "label": {
      const identifier = rest[0];
      const labelText = rest.slice(1).join(" ");
      if (!identifier || !labelText) {
        return {
          type: "error",
          text: "Usage: /actor label <address|#> <text>",
        };
      }
      return { type: "execute", command: "actor-label", args: [identifier, labelText] };
    }

    case "list":
      return { type: "execute", command: "actor-list", args: [] };

    case "logs": {
      const { flags, positional } = parseFlags(rest);
      const address = flags.address ?? positional[0];
      if (!address) {
        return { type: "error", text: "Usage: /actor logs <address>" };
      }
      return { type: "execute", command: "actor-logs", args: ["--address", address] };
    }

    default:
      return {
        type: "error",
        text: `Unknown actor command: ${sub || "(none)"}. Type /help for available commands.`,
      };
  }
}

function parseRunnerCommand(parts: string[]): CommandResult {
  const sub = parts[1]?.toLowerCase();
  const rest = parts.slice(2);

  switch (sub) {
    case "get": {
      const { flags, positional } = parseFlags(rest);
      const address = flags.address ?? positional[0];
      if (!address) {
        return { type: "error", text: "Usage: /runner get --address <address>" };
      }
      return { type: "execute", command: "runner-get", args: ["--address", address] };
    }

    case "list":
      return { type: "execute", command: "runner-list", args: [] };

    case "register": {
      const { flags } = parseFlags(rest);
      if (!flags.stake) {
        return { type: "error", text: "Usage: /runner register --stake <amount>" };
      }
      return { type: "execute", command: "runner-register", args: ["--stake", flags.stake] };
    }

    case "primary": {
      const address = rest[0] ?? "auto";
      return { type: "execute", command: "runner-primary", args: [address] };
    }

    case "helper": {
      const address = rest[0] ?? "auto";
      return { type: "execute", command: "runner-helper", args: [address] };
    }

    default:
      return {
        type: "error",
        text: `Unknown runner command: ${sub || "(none)"}. Type /help for available commands.`,
      };
  }
}

function parseJobCommand(parts: string[]): CommandResult {
  const sub = parts[1]?.toLowerCase();
  const rest = parts.slice(2);
  const { flags, positional } = parseFlags(rest);
  const jobId = flags["job-id"] ?? positional[0];

  switch (sub) {
    case "status":
      if (!jobId) return { type: "error", text: "Usage: /job status --job-id <id>" };
      return { type: "execute", command: "job-status", args: [jobId] };

    case "results":
      if (!jobId) return { type: "error", text: "Usage: /job results --job-id <id>" };
      return { type: "execute", command: "job-results", args: [jobId] };

    case "verified":
      if (!jobId) return { type: "error", text: "Usage: /job verified --job-id <id>" };
      return { type: "execute", command: "job-verified", args: [jobId] };

    case "runners":
      if (!jobId) return { type: "error", text: "Usage: /job runners --job-id <id>" };
      return { type: "execute", command: "job-runners", args: [jobId] };

    default:
      return {
        type: "error",
        text: `Unknown job command: ${sub || "(none)"}. Type /help for available commands.`,
      };
  }
}

function parseWalletCommand(parts: string[]): CommandResult {
  const sub = parts[1]?.toLowerCase();
  const rest = parts.slice(2);

  switch (sub) {
    case "create": {
      const { flags } = parseFlags(rest);
      const args: string[] = [];
      if (flags.output) args.push("--output", flags.output);
      return { type: "execute", command: "wallet-create", args };
    }

    case "address": {
      const { flags } = parseFlags(rest);
      const args: string[] = [];
      if (flags.key) args.push("--key", flags.key);
      return { type: "execute", command: "wallet-address", args };
    }

    case "balance": {
      const { flags } = parseFlags(rest);
      const args: string[] = [];
      if (flags.key) args.push("--key", flags.key);
      return { type: "execute", command: "wallet-balance", args };
    }

    case "export": {
      // parseFlags expects every `--flag` to be followed by a value, so pre-strip
      // the bare boolean flag before delegating.
      const noPrefix = rest.includes("--no-prefix");
      const { flags } = parseFlags(rest.filter((p) => p !== "--no-prefix"));
      const args: string[] = [];
      if (flags.key) args.push("--key", flags.key);
      if (noPrefix) args.push("--no-prefix");
      return { type: "execute", command: "wallet-export", args };
    }

    case "import": {
      // parseFlags expects every `--flag` to be followed by a value, so pre-strip
      // the bare boolean flag before delegating. `--force` only applies to the
      // hex flow (the underlying `wallet import-mnemonic` has no overwrite
      // override and simply refuses if the output exists).
      const force = rest.includes("--force");
      const { flags } = parseFlags(rest.filter((p) => p !== "--force"));
      if (flags.hex && flags.mnemonic) {
        return {
          type: "error",
          text: "Pass either --hex or --mnemonic, not both.",
        };
      }
      if (flags.hex) {
        // Route the secret through the cowboy CLI's --hex-file path with `-`
        // (stdin) instead of placing it on argv. Argv is readable by any local
        // process via `ps` / `/proc/<pid>/cmdline` for the duration of the
        // subprocess, which is a real exposure vector on shared hosts and CI.
        const args = ["--hex-file", "-"];
        if (flags.output) args.push("--output", flags.output);
        if (force) args.push("--force");
        return {
          type: "execute",
          command: "wallet-import-hex",
          args,
          stdin: flags.hex,
        };
      }
      if (flags.mnemonic) {
        // Same rationale as the hex branch — pipe the phrase via stdin so it
        // never appears in argv.
        const args = ["--mnemonic-file", "-"];
        if (flags.output) args.push("--output", flags.output);
        if (flags.index) args.push("--index", flags.index);
        return {
          type: "execute",
          command: "wallet-import-mnemonic",
          args,
          stdin: flags.mnemonic,
        };
      }
      return {
        type: "error",
        text:
          "Usage: /wallet import --hex <hex> [--output <path>] [--force]\n" +
          '       /wallet import --mnemonic "<phrase>" [--output <path>] [--index <n>]',
      };
    }

    default:
      return {
        type: "error",
        text: `Unknown wallet command: ${sub || "(none)"}. Type /help for available commands.`,
      };
  }
}

function parseTokenCommand(parts: string[]): CommandResult {
  const sub = parts[1]?.toLowerCase();
  const rest = parts.slice(2);

  switch (sub) {
    case "launch":
      return { type: "wizard", wizard: "token-launch" };

    case "create": {
      const { flags } = parseFlags(rest);
      if (!flags.name || !flags.symbol || !flags["initial-supply"]) {
        return {
          type: "error",
          text: "Usage: /token create --name <n> --symbol <s> --initial-supply <amount> [--decimals <d>] [--max-supply <m>]",
        };
      }
      const args = ["--name", flags.name, "--symbol", flags.symbol, "--initial-supply", flags["initial-supply"]];
      if (flags.decimals) args.push("--decimals", flags.decimals);
      if (flags["max-supply"]) args.push("--max-supply", flags["max-supply"]);
      return { type: "execute", command: "token-create", args };
    }

    case "transfer": {
      const { flags } = parseFlags(rest);
      if (!flags["token-id"] || !flags.to || !flags.amount) {
        return {
          type: "error",
          text: "Usage: /token transfer --token-id <id> --to <address> --amount <n>",
        };
      }
      return {
        type: "execute",
        command: "token-transfer",
        args: ["--token-id", flags["token-id"], "--to", flags.to, "--amount", flags.amount],
      };
    }

    case "approve": {
      const { flags } = parseFlags(rest);
      if (!flags["token-id"] || !flags.spender || !flags.amount) {
        return {
          type: "error",
          text: "Usage: /token approve --token-id <id> --spender <address> --amount <n>",
        };
      }
      return {
        type: "execute",
        command: "token-approve",
        args: ["--token-id", flags["token-id"], "--spender", flags.spender, "--amount", flags.amount],
      };
    }

    case "mint": {
      const { flags } = parseFlags(rest);
      if (!flags["token-id"] || !flags.to || !flags.amount) {
        return {
          type: "error",
          text: "Usage: /token mint --token-id <id> --to <address> --amount <n>",
        };
      }
      return {
        type: "execute",
        command: "token-mint",
        args: ["--token-id", flags["token-id"], "--to", flags.to, "--amount", flags.amount],
      };
    }

    case "burn": {
      const { flags } = parseFlags(rest);
      if (!flags["token-id"] || !flags.amount) {
        return {
          type: "error",
          text: "Usage: /token burn --token-id <id> --amount <n>",
        };
      }
      return {
        type: "execute",
        command: "token-burn",
        args: ["--token-id", flags["token-id"], "--amount", flags.amount],
      };
    }

    case "info": {
      const { flags } = parseFlags(rest);
      if (!flags["token-id"]) {
        return { type: "error", text: "Usage: /token info --token-id <id>" };
      }
      return { type: "execute", command: "token-info", args: ["--token-id", flags["token-id"]] };
    }

    case "balance": {
      const { flags } = parseFlags(rest);
      if (!flags["token-id"] || !flags.address) {
        return {
          type: "error",
          text: "Usage: /token balance --token-id <id> --address <address>",
        };
      }
      return {
        type: "execute",
        command: "token-balance",
        args: ["--token-id", flags["token-id"], "--address", flags.address],
      };
    }

    case "list":
      return { type: "execute", command: "token-list", args: [] };

    default:
      return {
        type: "error",
        text: `Unknown token command: ${sub || "(none)"}. Type /help for available commands.`,
      };
  }
}

function parseWatchtowerCommand(parts: string[]): CommandResult {
  const sub = parts[1]?.toLowerCase();
  const rest = parts.slice(2);

  switch (sub) {
    case "new": {
      const resource = rest[0]?.toLowerCase();
      if (resource !== "feed") {
        return { type: "error", text: "Usage: /watchtower new feed --name <n> [--description <d>]" };
      }
      const { flags } = parseFlags(rest.slice(1));
      if (!flags.name) {
        return { type: "error", text: "Usage: /watchtower new feed --name <n> [--description <d>]" };
      }
      const args = ["--name", flags.name];
      if (flags.description) args.push("--description", flags.description);
      return { type: "execute", command: "watchtower-new-feed", args };
    }

    case "feed": {
      const feedId = rest[0];
      const feedSub = rest[1]?.toLowerCase();
      if (!feedId || !feedSub) {
        return { type: "error", text: "Usage: /watchtower feed <id> <publish|subscribers>" };
      }

      if (feedSub === "publish") {
        const { flags } = parseFlags(rest.slice(2));
        if (!flags.data) {
          return { type: "error", text: "Usage: /watchtower feed <id> publish --data <json>" };
        }
        return {
          type: "execute",
          command: "watchtower-feed-publish",
          args: [feedId, "publish", "--data", flags.data],
        };
      }

      if (feedSub === "subscribers") {
        return {
          type: "execute",
          command: "watchtower-feed-subscribers",
          args: [feedId, "subscribers"],
        };
      }

      return { type: "error", text: "Usage: /watchtower feed <id> <publish|subscribers>" };
    }

    case "list":
      return { type: "execute", command: "watchtower-list", args: [] };

    case "feeds":
      return { type: "execute", command: "watchtower-feeds", args: [] };

    default:
      return {
        type: "error",
        text: `Unknown watchtower command: ${sub || "(none)"}. Type /help for available commands.`,
      };
  }
}

function handleHelp(): CommandResult {
  const helpText = [
    "Slash Commands:",
    "",
    "  Plain text submits an AI job to the runner network.",
    "  Every local command starts with /",
    "",
    "  General:",
    "    /init [mesa|local]                      Initialize project (default: mesa, the public devnet)",
    "    /walkthrough [n]                        Guided tour of how Cowboy works",
    "    /docs [topic]                           Browse bundled Cowboy reference docs",
    "    /faucet [address]                       Request devnet CBY (defaults to your wallet)",
    "    /permissions [show|set <default|auto>]  View or change the approval mode",
    "    /transfer --to <addr> --amount <cby>   Transfer CBY to an address",
    "    /help                                   Show this help",
    "    /clear                                  Clear the console",
    "    /exit                                   Quit lasso",
    "",
    "  Wallet:",
    "    /wallet create [--output <path>]        Generate a new keypair",
    "    /wallet address [--key <path>]          Show wallet address",
    "    /wallet balance [--key <path>]          Show wallet balance",
    "    /wallet export [--key <path>] [--no-prefix]   Export the private key as hex",
    '    /wallet import --hex <hex> [--output <path>] [--force]',
    '    /wallet import --mnemonic "<phrase>" [--output <path>] [--index <n>]',
    "",
    "  Actor:",
    "    /actor deploy <file.py>                 Deploy an actor to the chain",
    "    /actor execute <address> <method> [--payload <json>]",
    "    /actor get <address>                    Get actor details",
    "    /actor address --code <f> --creator <c> --salt <s>",
    "    /actor new <name>                       Scaffold a new actor project",
    "    /actor label <address|#> <text>         Set a label for an actor",
    "    /actor list                             List deployed actors",
    "    /actor logs <address>                   View actor logs",
    "    /simulate <file> <handler> [payload]    Run a handler locally against the PVM (advisory)",
    "",
    "  Sync:",
    "    /sync push [volume]                     Upload project files to the wallet's CBFS volume",
    "    /sync pull [volume]                     Download the CBFS volume into the local project",
    "",
    "  Secrets (stored locally, never leave this machine):",
    "    /secrets set <NAME>                     Store a secret (masked input)",
    "    /secrets list                           List secret names (never values)",
    "    /secrets delete <NAME>                  Remove a secret",
    "",
    "  Runner:",
    "    /runner list                            List active runners and local routing hints",
    "    /runner get --address <a>               Get runner details",
    "    /runner primary [<address>|auto]        Set preferred primary runner",
    "    /runner helper [<address>|auto]         Set preferred helper runner",
    "    /runner register --stake <amount>       Register as a runner",
    "",
    "  Jobs:",
    "    /job status --job-id <id>               Check job status",
    "    /job results --job-id <id>              Get raw job results",
    "    /job verified --job-id <id>             Get verified result",
    "    /job runners --job-id <id>              Show assigned runners",
    "",
    "  Token (CIP-20):",
    "    /token launch                           Interactive token creation wizard",
    "    /token create --name <n> --symbol <s> --initial-supply <n>",
    "    /token transfer --token-id <id> --to <addr> --amount <n>",
    "    /token approve --token-id <id> --spender <addr> --amount <n>",
    "    /token mint --token-id <id> --to <addr> --amount <n>",
    "    /token burn --token-id <id> --amount <n>",
    "    /token info --token-id <id>",
    "    /token balance --token-id <id> --address <addr>",
    "    /token list",
    "",
    "  Watchtower:",
    "    /watchtower new feed --name <n> [--description <d>]",
    "    /watchtower feed <id> publish --data <json>",
    "    /watchtower feed <id> subscribers",
    "    /watchtower list",
    "    /watchtower feeds",
    "",
    "  AI Prompt Routing:",
    "    build me an escrow actor with retries",
    "    refactor actors/hello into a counter example",
  ].join("\n");

  return { type: "output", text: helpText };
}
