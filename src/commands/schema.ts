export type CompletionValueKind =
  | { type: "text" }
  | { type: "number" }
  | { type: "json" }
  | { type: "path"; directoriesOnly?: boolean }
  | { type: "actor" }
  | { type: "feed" }
  | { type: "choice"; options: string[] };

export interface RouteSegmentLiteral {
  type: "literal";
  value: string;
}

export interface RouteSegmentArgument {
  type: "argument";
  name: string;
  valueKind: CompletionValueKind;
}

export type RouteSegment = RouteSegmentLiteral | RouteSegmentArgument;

export interface FlagSpec {
  name: string;
  description: string;
  valueKind?: CompletionValueKind;
}

export interface PositionalSpec {
  name: string;
  valueKind: CompletionValueKind;
  greedy?: boolean;
}

export interface CommandSpec {
  parserKey: string;
  section: string;
  usage: string;
  summary: string;
  route: RouteSegment[];
  positionals?: PositionalSpec[];
  flags?: FlagSpec[];
}

const literal = (value: string): RouteSegmentLiteral => ({ type: "literal", value });
const argument = (name: string, valueKind: CompletionValueKind): RouteSegmentArgument => ({
  type: "argument",
  name,
  valueKind,
});

export const COMMAND_SPECS: CommandSpec[] = [
  {
    parserKey: "help",
    section: "General",
    usage: "help",
    summary: "Show this help",
    route: [literal("help")],
  },
  {
    parserKey: "clear",
    section: "General",
    usage: "clear",
    summary: "Clear the console",
    route: [literal("clear")],
  },
  {
    parserKey: "exit",
    section: "General",
    usage: "exit",
    summary: "Quit lasso",
    route: [literal("exit")],
  },
  {
    parserKey: "quit",
    section: "General",
    usage: "quit",
    summary: "Quit lasso",
    route: [literal("quit")],
  },
  {
    parserKey: "init",
    section: "General",
    usage: "init <local|dev>",
    summary: "Initialize project environment",
    route: [literal("init")],
    positionals: [{ name: "environment", valueKind: { type: "choice", options: ["local", "dev"] } }],
  },
  {
    parserKey: "transfer",
    section: "General",
    usage: "transfer --to <addr> --amount <cby>",
    summary: "Transfer CBY to an address",
    route: [literal("transfer")],
    flags: [
      { name: "--to", description: "Destination address", valueKind: { type: "text" } },
      { name: "--amount", description: "Amount in CBY", valueKind: { type: "number" } },
    ],
  },
  {
    parserKey: "deploy-actor-legacy",
    section: "Actor",
    usage: "deploy actor <file.py>",
    summary: "Deploy an actor to the chain",
    route: [literal("deploy"), literal("actor")],
    positionals: [{ name: "filePath", valueKind: { type: "path" } }],
  },
  {
    parserKey: "actor-deploy",
    section: "Actor",
    usage: "actor deploy <file.py>",
    summary: "Deploy an actor to the chain",
    route: [literal("actor"), literal("deploy")],
    positionals: [{ name: "filePath", valueKind: { type: "path" } }],
  },
  {
    parserKey: "actor-execute",
    section: "Actor",
    usage: "actor execute <address> <method> [--payload <json>]",
    summary: "Execute an actor handler",
    route: [literal("actor"), literal("execute")],
    positionals: [
      { name: "actor", valueKind: { type: "actor" } },
      { name: "handler", valueKind: { type: "text" } },
    ],
    flags: [
      { name: "--actor", description: "Actor address", valueKind: { type: "actor" } },
      { name: "--handler", description: "Handler name", valueKind: { type: "text" } },
      { name: "--payload", description: "Payload hex/json", valueKind: { type: "json" } },
      { name: "--cycles-limit", description: "Cycles limit", valueKind: { type: "number" } },
      { name: "--cells-limit", description: "Cells limit", valueKind: { type: "number" } },
    ],
  },
  {
    parserKey: "actor-get",
    section: "Actor",
    usage: "actor get --address <a>",
    summary: "Get actor details",
    route: [literal("actor"), literal("get")],
    flags: [{ name: "--address", description: "Actor address", valueKind: { type: "actor" } }],
  },
  {
    parserKey: "actor-address",
    section: "Actor",
    usage: "actor address --code <f> --creator <c> --salt <s>",
    summary: "Compute actor address",
    route: [literal("actor"), literal("address")],
    flags: [
      { name: "--code", description: "Actor file", valueKind: { type: "path" } },
      { name: "--creator", description: "Creator address", valueKind: { type: "text" } },
      { name: "--salt", description: "Salt hex", valueKind: { type: "text" } },
    ],
  },
  {
    parserKey: "actor-new",
    section: "Actor",
    usage: "actor new <name>",
    summary: "Scaffold a new actor project",
    route: [literal("actor"), literal("new")],
    positionals: [{ name: "name", valueKind: { type: "text" } }],
  },
  {
    parserKey: "actor-label",
    section: "Actor",
    usage: "actor label <address|#> <text>",
    summary: "Set a label for an actor",
    route: [literal("actor"), literal("label")],
    positionals: [
      { name: "actor", valueKind: { type: "actor" } },
      { name: "label", valueKind: { type: "text" }, greedy: true },
    ],
  },
  {
    parserKey: "actor-list",
    section: "Actor",
    usage: "actor list",
    summary: "List deployed actors",
    route: [literal("actor"), literal("list")],
  },
  {
    parserKey: "actor-logs",
    section: "Actor",
    usage: "actor logs --address <a>",
    summary: "View actor logs",
    route: [literal("actor"), literal("logs")],
    flags: [{ name: "--address", description: "Actor address", valueKind: { type: "actor" } }],
  },
  {
    parserKey: "runner-get",
    section: "Runner",
    usage: "runner get --address <a>",
    summary: "Get runner details",
    route: [literal("runner"), literal("get")],
    flags: [{ name: "--address", description: "Runner address", valueKind: { type: "text" } }],
  },
  {
    parserKey: "runner-list",
    section: "Runner",
    usage: "runner list",
    summary: "List all runners",
    route: [literal("runner"), literal("list")],
  },
  {
    parserKey: "runner-register",
    section: "Runner",
    usage: "runner register --stake <amount>",
    summary: "Register as a runner",
    route: [literal("runner"), literal("register")],
    flags: [{ name: "--stake", description: "Stake amount", valueKind: { type: "number" } }],
  },
  {
    parserKey: "wallet-create",
    section: "Wallet",
    usage: "wallet create [--output <path>]",
    summary: "Generate a new keypair",
    route: [literal("wallet"), literal("create")],
    flags: [{ name: "--output", description: "Output path", valueKind: { type: "path" } }],
  },
  {
    parserKey: "wallet-address",
    section: "Wallet",
    usage: "wallet address [--key <path>]",
    summary: "Show wallet address",
    route: [literal("wallet"), literal("address")],
    flags: [{ name: "--key", description: "Key path", valueKind: { type: "path" } }],
  },
  {
    parserKey: "wallet-balance",
    section: "Wallet",
    usage: "wallet balance [--key <path>]",
    summary: "Show wallet balance",
    route: [literal("wallet"), literal("balance")],
    flags: [{ name: "--key", description: "Key path", valueKind: { type: "path" } }],
  },
  {
    parserKey: "token-create",
    section: "Token (CIP-20)",
    usage: "token create --name <n> --symbol <s> --initial-supply <n>",
    summary: "Create a new token",
    route: [literal("token"), literal("create")],
    flags: [
      { name: "--name", description: "Token name", valueKind: { type: "text" } },
      { name: "--symbol", description: "Token symbol", valueKind: { type: "text" } },
      { name: "--initial-supply", description: "Initial supply", valueKind: { type: "number" } },
      { name: "--decimals", description: "Token decimals", valueKind: { type: "number" } },
      { name: "--max-supply", description: "Max supply", valueKind: { type: "number" } },
    ],
  },
  {
    parserKey: "token-transfer",
    section: "Token (CIP-20)",
    usage: "token transfer --token-id <id> --to <addr> --amount <n>",
    summary: "Transfer tokens",
    route: [literal("token"), literal("transfer")],
    flags: [
      { name: "--token-id", description: "Token id", valueKind: { type: "text" } },
      { name: "--to", description: "Destination address", valueKind: { type: "text" } },
      { name: "--amount", description: "Amount", valueKind: { type: "number" } },
    ],
  },
  {
    parserKey: "token-approve",
    section: "Token (CIP-20)",
    usage: "token approve --token-id <id> --spender <addr> --amount <n>",
    summary: "Approve spender",
    route: [literal("token"), literal("approve")],
    flags: [
      { name: "--token-id", description: "Token id", valueKind: { type: "text" } },
      { name: "--spender", description: "Spender address", valueKind: { type: "text" } },
      { name: "--amount", description: "Amount", valueKind: { type: "number" } },
    ],
  },
  {
    parserKey: "token-mint",
    section: "Token (CIP-20)",
    usage: "token mint --token-id <id> --to <addr> --amount <n>",
    summary: "Mint tokens",
    route: [literal("token"), literal("mint")],
    flags: [
      { name: "--token-id", description: "Token id", valueKind: { type: "text" } },
      { name: "--to", description: "Destination address", valueKind: { type: "text" } },
      { name: "--amount", description: "Amount", valueKind: { type: "number" } },
    ],
  },
  {
    parserKey: "token-burn",
    section: "Token (CIP-20)",
    usage: "token burn --token-id <id> --amount <n>",
    summary: "Burn tokens",
    route: [literal("token"), literal("burn")],
    flags: [
      { name: "--token-id", description: "Token id", valueKind: { type: "text" } },
      { name: "--amount", description: "Amount", valueKind: { type: "number" } },
    ],
  },
  {
    parserKey: "token-info",
    section: "Token (CIP-20)",
    usage: "token info --token-id <id>",
    summary: "Show token info",
    route: [literal("token"), literal("info")],
    flags: [{ name: "--token-id", description: "Token id", valueKind: { type: "text" } }],
  },
  {
    parserKey: "token-balance",
    section: "Token (CIP-20)",
    usage: "token balance --token-id <id> --address <addr>",
    summary: "Show token balance",
    route: [literal("token"), literal("balance")],
    flags: [
      { name: "--token-id", description: "Token id", valueKind: { type: "text" } },
      { name: "--address", description: "Address", valueKind: { type: "text" } },
    ],
  },
  {
    parserKey: "token-list",
    section: "Token (CIP-20)",
    usage: "token list",
    summary: "List all tokens",
    route: [literal("token"), literal("list")],
  },
  {
    parserKey: "watchtower-new-feed",
    section: "Watchtower",
    usage: "watchtower new feed --name <n> [--description <d>]",
    summary: "Create a new data feed",
    route: [literal("watchtower"), literal("new"), literal("feed")],
    flags: [
      { name: "--name", description: "Feed name", valueKind: { type: "text" } },
      { name: "--description", description: "Feed description", valueKind: { type: "text" } },
    ],
  },
  {
    parserKey: "watchtower-feed-publish",
    section: "Watchtower",
    usage: "watchtower feed <id> publish --data <json>",
    summary: "Publish data to a feed",
    route: [literal("watchtower"), literal("feed"), argument("feedId", { type: "feed" }), literal("publish")],
    flags: [{ name: "--data", description: "Data JSON", valueKind: { type: "json" } }],
  },
  {
    parserKey: "watchtower-feed-subscribers",
    section: "Watchtower",
    usage: "watchtower feed <id> subscribers",
    summary: "List feed subscribers",
    route: [literal("watchtower"), literal("feed"), argument("feedId", { type: "feed" }), literal("subscribers")],
  },
  {
    parserKey: "watchtower-list",
    section: "Watchtower",
    usage: "watchtower list",
    summary: "List all feeds",
    route: [literal("watchtower"), literal("list")],
  },
  {
    parserKey: "watchtower-feeds",
    section: "Watchtower",
    usage: "watchtower feeds",
    summary: "List your feeds",
    route: [literal("watchtower"), literal("feeds")],
  },
];

export function renderHelpText(specs: CommandSpec[]): string {
  const sections = new Map<string, CommandSpec[]>();

  for (const spec of specs) {
    const list = sections.get(spec.section) ?? [];
    list.push(spec);
    sections.set(spec.section, list);
  }

  return [
    "Commands:",
    "",
    ...Array.from(sections.entries()).flatMap(([section, entries]) => {
      const lines = [`  ${section}:`];
      for (const entry of entries) {
        if (entry.usage.length >= 40) {
          lines.push(`    ${entry.usage}`);
          lines.push(`                                            ${entry.summary}`);
        } else {
          lines.push(`    ${entry.usage.padEnd(40)}${entry.summary}`);
        }
      }
      lines.push("");
      return lines;
    }),
  ].join("\n").trimEnd();
}

export function findCommandSpec(path: string[]): CommandSpec | undefined {
  return COMMAND_SPECS.find((spec) =>
    spec.route.every((segment, index) =>
      segment.type === "literal" && path[index]?.toLowerCase() === segment.value
    ) && path.length === spec.route.filter((segment) => segment.type === "literal").length
  );
}

export function findMatchingSpecs(tokens: string[]): CommandSpec[] {
  return COMMAND_SPECS.filter((spec) => matchesSpecTokens(spec, tokens));
}

export function matchesSpecTokens(spec: CommandSpec, tokens: string[]): boolean {
  let routeIndex = 0;
  let positionalIndex = 0;
  let expectingFlagValue: FlagSpec | undefined;

  for (const token of tokens) {
    if (expectingFlagValue) {
      expectingFlagValue = undefined;
      continue;
    }

    if (token.startsWith("--")) {
      const flag = spec.flags?.find((candidate) => candidate.name === token);
      if (!flag) return false;
      expectingFlagValue = flag.valueKind ? flag : undefined;
      continue;
    }

    if (routeIndex < spec.route.length) {
      const segment = spec.route[routeIndex];
      if (segment.type === "literal") {
        if (token.toLowerCase() !== segment.value) {
          return false;
        }
      }
      routeIndex++;
      continue;
    }

    const positional = spec.positionals?.[Math.min(positionalIndex, (spec.positionals?.length ?? 1) - 1)];
    if (!positional) return false;
    if (!positional.greedy) {
      positionalIndex++;
    }
  }

  return !expectingFlagValue;
}
