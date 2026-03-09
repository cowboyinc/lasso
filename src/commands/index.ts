import type { CommandResult } from "../types.js";

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

  // Normalize: strip leading / if user types it by habit
  const normalized = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const parts = normalized.split(/\s+/);
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
      const env = parts[1]?.toLowerCase();
      if (!env || !["dev", "local"].includes(env)) {
        return { type: "error", text: "Usage: init <local|dev>" };
      }
      return { type: "execute", command: "init", args: [env] };
    }

    case "deploy": {
      // deploy actor <file>
      if (parts[1]?.toLowerCase() === "actor") {
        const filePath = parts.slice(2).join(" ");
        if (!filePath) {
          return { type: "error", text: "Usage: deploy actor <file_path>" };
        }
        return { type: "execute", command: "deploy-actor", args: [filePath] };
      }
      return {
        type: "error",
        text: `Unknown deploy target: ${parts[1] || "(none)"}. Usage: deploy actor <file>`,
      };
    }

    case "actor": {
      const sub = parts[1]?.toLowerCase();
      const rest = parts.slice(2);

      switch (sub) {
        case "deploy": {
          const filePath = rest.join(" ");
          if (!filePath) {
            return { type: "error", text: "Usage: actor deploy <file_path>" };
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
              text: "Usage: actor execute <address> <method> [--payload <json>]",
            };
          }
          const payload = flags.payload ?? "7b7d";
          const args = ["--actor", actor, "--handler", handler, "--payload", payload];
          return { type: "execute", command: "actor-execute", args };
        }

        case "get": {
          const { flags } = parseFlags(rest);
          if (!flags.address) {
            return { type: "error", text: "Usage: actor get --address <address>" };
          }
          return { type: "execute", command: "actor-get", args: ["--address", flags.address] };
        }

        case "address": {
          const { flags } = parseFlags(rest);
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

        case "new": {
          const name = rest[0];
          if (!name) {
            return { type: "error", text: "Usage: actor new <name>" };
          }
          return { type: "execute", command: "actor-new", args: [name] };
        }

        case "list":
          return { type: "execute", command: "actor-list", args: [] };

        case "logs": {
          const { flags } = parseFlags(rest);
          if (!flags.address) {
            return { type: "error", text: "Usage: actor logs --address <address>" };
          }
          return { type: "execute", command: "actor-logs", args: ["--address", flags.address] };
        }

        default:
          return {
            type: "error",
            text: `Unknown actor command: ${sub || "(none)"}. Type help for available commands.`,
          };
      }
    }

    case "runner": {
      const sub = parts[1]?.toLowerCase();
      const rest = parts.slice(2);

      switch (sub) {
        case "get": {
          const { flags } = parseFlags(rest);
          if (!flags.address) {
            return { type: "error", text: "Usage: runner get --address <address>" };
          }
          return { type: "execute", command: "runner-get", args: ["--address", flags.address] };
        }

        case "list":
          return { type: "execute", command: "runner-list", args: [] };

        case "register": {
          const { flags } = parseFlags(rest);
          if (!flags.stake) {
            return { type: "error", text: "Usage: runner register --stake <amount>" };
          }
          return { type: "execute", command: "runner-register", args: ["--stake", flags.stake] };
        }

        default:
          return {
            type: "error",
            text: `Unknown runner command: ${sub || "(none)"}. Type help for available commands.`,
          };
      }
    }

    case "transfer": {
      const { flags } = parseFlags(parts.slice(1));
      if (!flags.to || !flags.amount) {
        return { type: "error", text: "Usage: transfer --to <address> --amount <cby>" };
      }
      return { type: "execute", command: "transfer", args: ["--to", flags.to, "--amount", flags.amount] };
    }

    case "wallet": {
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

        default:
          return {
            type: "error",
            text: `Unknown wallet command: ${sub || "(none)"}. Type help for available commands.`,
          };
      }
    }

    case "token": {
      const sub = parts[1]?.toLowerCase();
      const rest = parts.slice(2);

      switch (sub) {
        case "create": {
          const { flags } = parseFlags(rest);
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

        case "transfer": {
          const { flags } = parseFlags(rest);
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

        case "approve": {
          const { flags } = parseFlags(rest);
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

        case "mint": {
          const { flags } = parseFlags(rest);
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

        case "burn": {
          const { flags } = parseFlags(rest);
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

        case "info": {
          const { flags } = parseFlags(rest);
          if (!flags["token-id"]) {
            return { type: "error", text: "Usage: token info --token-id <id>" };
          }
          return { type: "execute", command: "token-info", args: ["--token-id", flags["token-id"]] };
        }

        case "balance": {
          const { flags } = parseFlags(rest);
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

        case "list":
          return { type: "execute", command: "token-list", args: [] };

        default:
          return {
            type: "error",
            text: `Unknown token command: ${sub || "(none)"}. Type help for available commands.`,
          };
      }
    }

    case "watchtower": {
      const sub = parts[1]?.toLowerCase();
      const rest = parts.slice(2);

      switch (sub) {
        case "new": {
          const resource = rest[0]?.toLowerCase();
          if (resource !== "feed") {
            return { type: "error", text: "Usage: watchtower new feed --name <n> [--description <d>]" };
          }
          const { flags } = parseFlags(rest.slice(1));
          if (!flags.name) {
            return { type: "error", text: "Usage: watchtower new feed --name <n> [--description <d>]" };
          }
          const args = ["--name", flags.name];
          if (flags.description) args.push("--description", flags.description);
          return { type: "execute", command: "watchtower-new-feed", args };
        }

        case "feed": {
          const feedId = rest[0];
          const feedSub = rest[1]?.toLowerCase();
          if (!feedId || !feedSub) {
            return { type: "error", text: "Usage: watchtower feed <id> <publish|subscribers>" };
          }

          if (feedSub === "publish") {
            const { flags } = parseFlags(rest.slice(2));
            if (!flags.data) {
              return { type: "error", text: "Usage: watchtower feed <id> publish --data <json>" };
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

          return { type: "error", text: "Usage: watchtower feed <id> <publish|subscribers>" };
        }

        case "list":
          return { type: "execute", command: "watchtower-list", args: [] };

        case "feeds":
          return { type: "execute", command: "watchtower-feeds", args: [] };

        default:
          return {
            type: "error",
            text: `Unknown watchtower command: ${sub || "(none)"}. Type help for available commands.`,
          };
      }
    }

    default:
      return {
        type: "error",
        text: `Unknown command: ${trimmed}. Type help for available commands.`,
      };
  }
}

function handleHelp(): CommandResult {
  const helpText = [
    "Commands:",
    "",
    "  General:",
    "    init <local|dev>                        Initialize project environment",
    "    transfer --to <addr> --amount <cby>     Transfer CBY to an address",
    "    help                                    Show this help",
    "    clear                                   Clear the console",
    "    exit                                    Quit lasso",
    "",
    "  Wallet:",
    "    wallet create [--output <path>]         Generate a new keypair",
    "    wallet address [--key <path>]           Show wallet address",
    "    wallet balance [--key <path>]           Show wallet balance",
    "",
    "  Actor:",
    "    actor deploy <file.py>                  Deploy an actor to the chain",
    "    actor execute <address> <method> [--payload <json>]",
    "                                            Execute an actor handler",
    "    actor get --address <a>                 Get actor details",
    "    actor address --code <f> --creator <c> --salt <s>",
    "                                            Compute actor address",
    "    actor new <name>                        Scaffold a new actor project",
    "    actor list                              List deployed actors",
    "    actor logs --address <a>                View actor logs",
    "",
    "  Runner:",
    "    runner get --address <a>                Get runner details",
    "    runner list                             List all runners",
    "    runner register --stake <amount>        Register as a runner",
    "",
    "  Token (CIP-20):",
    "    token create --name <n> --symbol <s> --initial-supply <n>",
    "                                            Create a new token",
    "    token transfer --token-id <id> --to <addr> --amount <n>",
    "                                            Transfer tokens",
    "    token approve --token-id <id> --spender <addr> --amount <n>",
    "                                            Approve spender",
    "    token mint --token-id <id> --to <addr> --amount <n>",
    "                                            Mint tokens",
    "    token burn --token-id <id> --amount <n> Burn tokens",
    "    token info --token-id <id>              Show token info",
    "    token balance --token-id <id> --address <addr>",
    "                                            Show token balance",
    "    token list                              List all tokens",
    "",
    "  Watchtower:",
    "    watchtower new feed --name <n> [--description <d>]",
    "                                            Create a new data feed",
    "    watchtower feed <id> publish --data <json>",
    "                                            Publish data to a feed",
    "    watchtower feed <id> subscribers        List feed subscribers",
    "    watchtower list                         List all feeds",
    "    watchtower feeds                        List your feeds",
  ].join("\n");

  return { type: "output", text: helpText };
}
