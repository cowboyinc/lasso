import type { CommandResult } from "../types.js";

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

    case "init":
      return { type: "init" };

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
      // actor deploy <file>
      if (parts[1]?.toLowerCase() === "deploy") {
        const filePath = parts.slice(2).join(" ");
        if (!filePath) {
          return { type: "error", text: "Usage: actor deploy <file_path>" };
        }
        return { type: "execute", command: "deploy-actor", args: [filePath] };
      }
      return {
        type: "error",
        text: `Unknown actor command: ${parts[1] || "(none)"}. Usage: actor deploy <file>`,
      };
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
    "  init                        Set your private key",
    "  deploy actor <file.py>      Deploy an actor to the chain",
    "  help                        Show this help",
    "  clear                       Clear the console",
    "  exit                        Quit lasso",
  ].join("\n");

  return { type: "output", text: helpText };
}
