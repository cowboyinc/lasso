import type { CommandResult } from "../types.js";
import { HELP_TEXT, tokenizeCommandInput } from "./autocomplete.js";
import { COMMAND_SPECS, matchesSpecTokens } from "./schema.js";

/**
 * Extract --key value pairs from a list of tokens.
 * Returns { flags, positional } where flags is a map of key->value
 * and positional is the leftover tokens.
 */
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

export function parseCommand(input: string): CommandResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { type: "output", text: "" };
  }

  const normalized = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const parts = tokenizeCommandInput(normalized);
  const spec = findParserSpec(parts);
  const command = spec?.parserKey ?? parts[0].toLowerCase();

  switch (command) {
    case "help":
      return handleHelp();

    case "clear":
      return { type: "clear" };

    case "exit":
    case "quit":
      return { type: "quit" };

    case "init": {
      const env = parts[1]?.toLowerCase();
      if (!env || !["dev", "local"].includes(env)) {
        return { type: "error", text: "Usage: init <local|dev>" };
      }
      return { type: "execute", command: "init", args: [env] };
    }

    case "deploy-actor-legacy": {
        const filePath = parts.slice(2).join(" ");
        if (!filePath) {
          return { type: "error", text: "Usage: deploy actor <file_path>" };
        }
        return { type: "execute", command: "deploy-actor", args: [filePath] };
    }

    case "actor-deploy": {
      const filePath = parts.slice(2).join(" ");
      if (!filePath) {
        return { type: "error", text: "Usage: actor deploy <file_path>" };
      }
      return { type: "execute", command: "deploy-actor", args: [filePath] };
    }

    case "actor-execute": {
      const rest = parts.slice(2);
      const { flags, positional } = parseFlags(rest);
      const actor = flags.actor ?? positional[0];
      const handler = flags.handler ?? positional[1];
      if (!actor || !handler) {
        return {
          type: "error",
          text: "Usage: actor execute <address> <method> [--payload <json>]",
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

    case "actor-get": {
      const { flags } = parseFlags(parts.slice(2));
      if (!flags.address) {
        return { type: "error", text: "Usage: actor get --address <address>" };
      }
      return { type: "execute", command: "actor-get", args: ["--address", flags.address] };
    }

    case "actor-address": {
      const { flags } = parseFlags(parts.slice(2));
      if (!flags.code || !flags.creator || !flags.salt) {
        return {
          type: "error",
          text: "Usage: actor address --code <file> --creator <address> --salt <hex>",
        };
      }
      return {
        type: "execute",
        command: "actor-address",
        args: ["--code", flags.code, "--creator", flags.creator, "--salt", flags.salt],
      };
    }

    case "actor-new": {
      const name = parts[2];
      if (!name) {
        return { type: "error", text: "Usage: actor new <name>" };
      }
      return { type: "execute", command: "actor-new", args: [name] };
    }

    case "actor-label": {
      const identifier = parts[2];
      const labelText = parts.slice(3).join(" ");
      if (!identifier || !labelText) {
        return {
          type: "error",
          text: "Usage: actor label <address|#> <text>",
        };
      }
      return { type: "execute", command: "actor-label", args: [identifier, labelText] };
    }

    case "actor-list":
      return { type: "execute", command: "actor-list", args: [] };

    case "actor-logs": {
      const { flags } = parseFlags(parts.slice(2));
      if (!flags.address) {
        return { type: "error", text: "Usage: actor logs --address <address>" };
      }
      return { type: "execute", command: "actor-logs", args: ["--address", flags.address] };
    }

    case "runner-get": {
      const rest = parts.slice(2);
      const { flags } = parseFlags(rest);
      if (!flags.address) {
        return { type: "error", text: "Usage: runner get --address <address>" };
      }
      return { type: "execute", command: "runner-get", args: ["--address", flags.address] };
    }

    case "runner-list":
      return { type: "execute", command: "runner-list", args: [] };

    case "runner-register": {
      const { flags } = parseFlags(parts.slice(2));
      if (!flags.stake) {
        return { type: "error", text: "Usage: runner register --stake <amount>" };
      }
      return { type: "execute", command: "runner-register", args: ["--stake", flags.stake] };
    }

    case "transfer": {
      const { flags } = parseFlags(parts.slice(1));
      if (!flags.to || !flags.amount) {
        return { type: "error", text: "Usage: transfer --to <address> --amount <cby>" };
      }
      return { type: "execute", command: "transfer", args: ["--to", flags.to, "--amount", flags.amount] };
    }

    case "wallet-create": {
      const { flags } = parseFlags(parts.slice(2));
      const args: string[] = [];
      if (flags.output) args.push("--output", flags.output);
      return { type: "execute", command: "wallet-create", args };
    }

    case "wallet-address": {
      const { flags } = parseFlags(parts.slice(2));
      const args: string[] = [];
      if (flags.key) args.push("--key", flags.key);
      return { type: "execute", command: "wallet-address", args };
    }

    case "wallet-balance": {
      const { flags } = parseFlags(parts.slice(2));
      const args: string[] = [];
      if (flags.key) args.push("--key", flags.key);
      return { type: "execute", command: "wallet-balance", args };
    }

    case "token-create": {
      const { flags } = parseFlags(parts.slice(2));
      if (!flags.name || !flags.symbol || !flags["initial-supply"]) {
        return {
          type: "error",
          text: "Usage: token create --name <n> --symbol <s> --initial-supply <amount> [--decimals <d>] [--max-supply <m>]",
        };
      }
      const args = ["--name", flags.name, "--symbol", flags.symbol, "--initial-supply", flags["initial-supply"]];
      if (flags.decimals) args.push("--decimals", flags.decimals);
      if (flags["max-supply"]) args.push("--max-supply", flags["max-supply"]);
      return { type: "execute", command: "token-create", args };
    }

    case "token-transfer": {
      const { flags } = parseFlags(parts.slice(2));
      if (!flags["token-id"] || !flags.to || !flags.amount) {
        return {
          type: "error",
          text: "Usage: token transfer --token-id <id> --to <address> --amount <n>",
        };
      }
      return {
        type: "execute",
        command: "token-transfer",
        args: ["--token-id", flags["token-id"], "--to", flags.to, "--amount", flags.amount],
      };
    }

    case "token-approve": {
      const { flags } = parseFlags(parts.slice(2));
      if (!flags["token-id"] || !flags.spender || !flags.amount) {
        return {
          type: "error",
          text: "Usage: token approve --token-id <id> --spender <address> --amount <n>",
        };
      }
      return {
        type: "execute",
        command: "token-approve",
        args: ["--token-id", flags["token-id"], "--spender", flags.spender, "--amount", flags.amount],
      };
    }

    case "token-mint": {
      const { flags } = parseFlags(parts.slice(2));
      if (!flags["token-id"] || !flags.to || !flags.amount) {
        return {
          type: "error",
          text: "Usage: token mint --token-id <id> --to <address> --amount <n>",
        };
      }
      return {
        type: "execute",
        command: "token-mint",
        args: ["--token-id", flags["token-id"], "--to", flags.to, "--amount", flags.amount],
      };
    }

    case "token-burn": {
      const { flags } = parseFlags(parts.slice(2));
      if (!flags["token-id"] || !flags.amount) {
        return {
          type: "error",
          text: "Usage: token burn --token-id <id> --amount <n>",
        };
      }
      return {
        type: "execute",
        command: "token-burn",
        args: ["--token-id", flags["token-id"], "--amount", flags.amount],
      };
    }

    case "token-info": {
      const { flags } = parseFlags(parts.slice(2));
      if (!flags["token-id"]) {
        return { type: "error", text: "Usage: token info --token-id <id>" };
      }
      return { type: "execute", command: "token-info", args: ["--token-id", flags["token-id"]] };
    }

    case "token-balance": {
      const { flags } = parseFlags(parts.slice(2));
      if (!flags["token-id"] || !flags.address) {
        return {
          type: "error",
          text: "Usage: token balance --token-id <id> --address <address>",
        };
      }
      return {
        type: "execute",
        command: "token-balance",
        args: ["--token-id", flags["token-id"], "--address", flags.address],
      };
    }

    case "token-list":
      return { type: "execute", command: "token-list", args: [] };

    case "watchtower-new-feed": {
      const { flags } = parseFlags(parts.slice(3));
      if (!flags.name) {
        return { type: "error", text: "Usage: watchtower new feed --name <n> [--description <d>]" };
      }
      const args = ["--name", flags.name];
      if (flags.description) args.push("--description", flags.description);
      return { type: "execute", command: "watchtower-new-feed", args };
    }

    case "watchtower-feed-publish": {
      const feedId = parts[2];
      const { flags } = parseFlags(parts.slice(4));
      if (!feedId || !flags.data) {
        return { type: "error", text: "Usage: watchtower feed <id> publish --data <json>" };
      }
      return {
        type: "execute",
        command: "watchtower-feed-publish",
        args: [feedId, "publish", "--data", flags.data],
      };
    }

    case "watchtower-feed-subscribers": {
      const feedId = parts[2];
      if (!feedId) {
        return { type: "error", text: "Usage: watchtower feed <id> subscribers" };
      }
      return {
        type: "execute",
        command: "watchtower-feed-subscribers",
        args: [feedId, "subscribers"],
      };
    }

    case "watchtower-list":
      return { type: "execute", command: "watchtower-list", args: [] };

    case "watchtower-feeds":
      return { type: "execute", command: "watchtower-feeds", args: [] };

    case "deploy":
    case "actor":
    case "runner":
    case "wallet":
    case "token":
    case "watchtower":
      return {
        type: "error",
        text: `Unknown command: ${trimmed}. Type help for available commands.`,
      };

    default:
      return {
        type: "error",
        text: `Unknown command: ${trimmed}. Type help for available commands.`,
      };
    }
}

function handleHelp(): CommandResult {
  return { type: "output", text: HELP_TEXT };
}

function findParserSpec(parts: string[]) {
  const matches = COMMAND_SPECS.filter((spec) => matchesSpecTokens(spec, parts));
  matches.sort((left, right) => right.route.length - left.route.length);
  return matches[0];
}
