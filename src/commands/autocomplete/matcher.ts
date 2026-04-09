import {
  COMMAND_SPECS,
  type CommandSpec,
  type FlagSpec,
} from "../schema.js";
import { resolveValueItems } from "./providers.js";
import type { CompletionContext, CompletionItem, MatchState } from "./types.js";

export async function resolveMatchState(
  previousTokens: string[],
  prefix: string,
  context: CompletionContext
): Promise<MatchState | null> {
  const explicitFlagSpec = findExplicitFlagSpec(previousTokens);
  if (explicitFlagSpec) {
    const spec = matchSpecForPrefix(previousTokens.slice(0, -1));
    if (!spec) return null;
    const valueKind = explicitFlagSpec.valueKind;
    if (!valueKind) return null;
    return {
      kind: "flag-value",
      valueKind,
      items: await resolveValueItems(valueKind, prefix, context),
    };
  }

  if (prefix.startsWith("--")) {
    const spec = matchSpecForPrefix(previousTokens);
    if (!spec) return null;
    return {
      kind: "flag",
      items: (spec.flags ?? [])
        .filter((flag) => flag.name.startsWith(prefix))
        .map((flag) => ({ value: flag.name, label: flag.name, detail: flag.description, kind: "flag" })),
    };
  }

  const matches = COMMAND_SPECS
    .map((spec) => ({ spec, state: getSpecCursorState(spec, previousTokens) }))
    .filter((entry) => entry.state !== null) as Array<{ spec: CommandSpec; state: MatchState }>;

  if (matches.length === 0) {
    return null;
  }

  const literalItems = dedupeCompletionItems(
    matches.flatMap(({ state }) => state.kind === "literal" ? (state.items ?? []) : [])
  ).filter((item) => item.value.startsWith(prefix.toLowerCase()));

  if (literalItems.length > 0) {
    return { kind: "literal", items: literalItems };
  }

  const flagItems = dedupeCompletionItems(
    matches.flatMap(({ state }) => state.kind === "flag" ? (state.items ?? []) : [])
  ).filter((item) => item.value.startsWith(prefix));

  if (flagItems.length > 0) {
    return { kind: "flag", items: flagItems };
  }

  const argumentStates = matches.filter(({ state }) => state.kind === "argument");
  if (argumentStates.length === 0) {
    return null;
  }

  const valueKind = argumentStates[0].state.valueKind;
  if (!valueKind) return null;

  return {
    kind: "argument",
    valueKind,
    items: await resolveValueItems(valueKind, prefix, context),
  };
}

export function getSpecCursorState(spec: CommandSpec, previousTokens: string[]): MatchState | null {
  let routeIndex = 0;
  let positionalIndex = 0;
  let expectingFlagValue = false;

  for (const token of previousTokens) {
    if (expectingFlagValue) {
      expectingFlagValue = false;
      continue;
    }

    if (token.startsWith("--")) {
      const flag = spec.flags?.find((candidate) => candidate.name === token);
      if (!flag) return null;
      expectingFlagValue = Boolean(flag.valueKind);
      continue;
    }

    if (routeIndex < spec.route.length) {
      const segment = spec.route[routeIndex];
      if (segment.type === "literal") {
        if (token.toLowerCase() !== segment.value) {
          return null;
        }
        routeIndex++;
        continue;
      }

      routeIndex++;
      continue;
    }

    const positional = spec.positionals?.[Math.min(positionalIndex, (spec.positionals?.length ?? 1) - 1)];
    if (!positional) return null;
    if (!positional.greedy) {
      positionalIndex++;
    }
  }

  if (expectingFlagValue) return null;

  if (routeIndex < spec.route.length) {
    const next = spec.route[routeIndex];
    if (next.type === "literal") {
      return {
        kind: "literal",
        items: [{ value: next.value, label: next.value, detail: spec.summary, kind: "command" }],
      };
    }
    return { kind: "argument", valueKind: next.valueKind };
  }

  const positional = spec.positionals?.[Math.min(positionalIndex, (spec.positionals?.length ?? 1) - 1)];
  if (positional) {
    return { kind: "argument", valueKind: positional.valueKind };
  }

  if (spec.flags && spec.flags.length > 0) {
    return {
      kind: "flag",
      items: spec.flags.map((flag) => ({
        value: flag.name,
        label: flag.name,
        detail: flag.description,
        kind: "flag",
      })),
    };
  }

  return null;
}

function findExplicitFlagSpec(previousTokens: string[]): FlagSpec | null {
  if (previousTokens.length === 0) return null;

  const flagToken = previousTokens[previousTokens.length - 1];
  if (!flagToken.startsWith("--")) {
    return null;
  }

  const spec = matchSpecForPrefix(previousTokens.slice(0, -1));
  const flag = spec?.flags?.find((candidate) => candidate.name === flagToken);
  return flag?.valueKind ? flag : null;
}

function matchSpecForPrefix(tokens: string[]): CommandSpec | null {
  const matches = COMMAND_SPECS.filter((spec) => matchesPrefix(spec, tokens));
  if (matches.length === 0) return null;
  matches.sort((left, right) => routeWeight(right) - routeWeight(left));
  return matches[0];
}

function matchesPrefix(spec: CommandSpec, tokens: string[]): boolean {
  let routeIndex = 0;

  for (const token of tokens) {
    if (token.startsWith("--")) {
      const flag = spec.flags?.find((candidate) => candidate.name === token);
      return Boolean(flag);
    }

    if (routeIndex < spec.route.length) {
      const segment = spec.route[routeIndex];
      if (segment.type === "literal" && token.toLowerCase() !== segment.value) {
        return false;
      }
      routeIndex++;
      continue;
    }

    return Boolean(spec.positionals && spec.positionals.length > 0);
  }

  return true;
}

function routeWeight(spec: CommandSpec): number {
  return spec.route.length + (spec.positionals?.length ?? 0);
}

function dedupeCompletionItems(items: CompletionItem[]): CompletionItem[] {
  const seen = new Set<string>();
  const result: CompletionItem[] = [];

  for (const item of items) {
    const key = `${item.kind}:${item.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}
