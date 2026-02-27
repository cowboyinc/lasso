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
        return { type: "error", text: "Usage: init <dev|local>" };
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
          const { flags } = parseFlags(rest);
          if (!flags.actor || !flags.handler) {
            return {
              type: "error",
              text: "Usage: actor execute --actor <address> --handler <method> [--payload <json>]",
            };
          }
          const args = ["--actor", flags.actor, "--handler", flags.handler];
          if (flags.payload) {
            args.push("--payload", flags.payload);
          }
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
    "    init <dev|local>                        Initialize project environment",
    "    help                                    Show this help",
    "    clear                                   Clear the console",
    "    exit                                    Quit lasso",
    "",
    "  Actor:",
    "    actor deploy <file.py>                  Deploy an actor to the chain",
    "    actor execute --actor <a> --handler <h> [--payload <json>]",
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
  ].join("\n");

  return { type: "output", text: helpText };
}
