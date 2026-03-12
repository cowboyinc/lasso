import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import type { FeedEntry, SessionState } from "../types.js";
import {
  COMMAND_SPECS,
  type CommandSpec,
  type CompletionValueKind,
  type FlagSpec,
  renderHelpText,
} from "./schema.js";

export interface TokenMatch {
  value: string;
  start: number;
  end: number;
}

export interface CompletionItem {
  value: string;
  label: string;
  detail?: string;
  kind: "command" | "flag" | "path" | "actor" | "feed" | "value";
}

export interface CompletionResult {
  tokenStart: number;
  tokenEnd: number;
  prefix: string;
  items: CompletionItem[];
}

export interface CompletionContext {
  input: string;
  cursorOffset: number;
  cwd: string;
  session: SessionState;
  cache: CompletionCache;
  providers?: Partial<Record<"path" | "actor" | "feed", CompletionProvider>>;
}

export type CompletionProvider = (request: ProviderRequest) => Promise<CompletionItem[]>;

interface ProviderRequest {
  prefix: string;
  cwd: string;
  session: SessionState;
  cache: CompletionCache;
}

interface NormalizedInput {
  value: string;
  cursor: number;
  offset: number;
}

interface TokenInfo {
  tokenStart: number;
  tokenEnd: number;
  prefix: string;
  previousTokens: string[];
}

interface MatchState {
  kind: "literal" | "argument" | "flag" | "flag-value";
  items?: CompletionItem[];
  valueKind?: CompletionValueKind;
}

export const HELP_TEXT = renderHelpText(COMMAND_SPECS);

export class CompletionCache {
  private readonly store = new Map<string, CompletionItem[]>();

  get(key: string): CompletionItem[] | undefined {
    return this.store.get(key);
  }

  set(key: string, value: CompletionItem[]): void {
    this.store.set(key, value);
  }

  invalidate(namespace?: string): void {
    if (!namespace) {
      this.store.clear();
      return;
    }

    for (const key of this.store.keys()) {
      if (key.startsWith(`${namespace}:`)) {
        this.store.delete(key);
      }
    }
  }
}

export function tokenizeCommandInput(input: string): string[] {
  return tokenizeWithSpans(input).map((token) => token.value);
}

export async function getCompletionResult(context: CompletionContext): Promise<CompletionResult | null> {
  const normalized = normalizeInput(context.input, context.cursorOffset);
  if (!normalized) {
    return null;
  }

  const tokens = tokenizeWithSpans(normalized.value);
  const tokenInfo = findTokenAtCursor(normalized.value, tokens, normalized.cursor);
  const prefix = tokenInfo.prefix;
  const state = await resolveMatchState(tokenInfo.previousTokens, prefix, context);
  if (!state?.items || state.items.length === 0) {
    return null;
  }

  return {
    tokenStart: tokenInfo.tokenStart + normalized.offset,
    tokenEnd: tokenInfo.tokenEnd + normalized.offset,
    prefix,
    items: state.items,
  };
}

export async function resolveCommandCompletions(input: string, cursorOffset: number): Promise<CompletionResult | null> {
  return getCompletionResult({
    input,
    cursorOffset,
    cwd: process.cwd(),
    session: {
      validatorUrl: "http://localhost:4000",
      walletAddress: null,
      actors: [],
      feeds: [],
    },
    cache: new CompletionCache(),
  });
}

async function resolveMatchState(
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

function getSpecCursorState(spec: CommandSpec, previousTokens: string[]): MatchState | null {
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

async function resolveValueItems(
  valueKind: CompletionValueKind,
  prefix: string,
  context: CompletionContext
): Promise<CompletionItem[]> {
  const cacheKey = getValueCacheKey(valueKind, prefix, context);
  const cached = context.cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let items: CompletionItem[];
  switch (valueKind.type) {
    case "choice":
      items = valueKind.options
        .filter((option) => option.startsWith(prefix.toLowerCase()))
        .map((option) => ({ value: option, label: option, kind: "value" as const }));
      break;
    case "path":
      items = await (context.providers?.path ?? pathProvider)({
        prefix,
        cwd: context.cwd,
        session: context.session,
        cache: context.cache,
      });
      break;
    case "actor":
      items = await (context.providers?.actor ?? actorProvider)({
        prefix,
        cwd: context.cwd,
        session: context.session,
        cache: context.cache,
      });
      break;
    case "feed":
      items = await (context.providers?.feed ?? feedProvider)({
        prefix,
        cwd: context.cwd,
        session: context.session,
        cache: context.cache,
      });
      break;
    default:
      items = [];
  }

  context.cache.set(cacheKey, items);
  return items;
}

async function pathProvider(request: ProviderRequest): Promise<CompletionItem[]> {
  const prefix = request.prefix;
  const cacheKey = `path:${request.cwd}:${prefix}`;
  const cached = request.cache.get(cacheKey);
  if (cached) return cached;

  const inputPath = prefix || "";
  const baseDir = inputPath.includes("/") ? dirname(inputPath) : ".";
  const fragment = inputPath.includes("/") ? basename(inputPath) : inputPath;
  const absoluteBaseDir = normalize(join(request.cwd, baseDir));

  let entries: string[] = [];
  try {
    entries = readdirSync(absoluteBaseDir);
  } catch {
    request.cache.set(cacheKey, []);
    return [];
  }

  const items = entries
    .filter((entry) => entry.startsWith(fragment))
    .map((entry) => {
      const relativePath = baseDir === "." ? entry : `${baseDir}/${entry}`;
      const isDirectory = statSync(join(absoluteBaseDir, entry)).isDirectory();
      const value = isDirectory ? `${relativePath}/` : relativePath;
      return {
        value,
        label: value,
        detail: isDirectory ? "directory" : undefined,
        kind: "path" as const,
      };
    })
    .sort((left, right) => left.value.localeCompare(right.value));

  request.cache.set(cacheKey, items);
  return items;
}

async function actorProvider(request: ProviderRequest): Promise<CompletionItem[]> {
  const signature = request.session.actors.map((actor) => `${actor.address}:${actor.label}`).join("|");
  const cacheKey = `actor:${signature}:${request.prefix}`;
  const cached = request.cache.get(cacheKey);
  if (cached) return cached;

  const items = request.session.actors
    .filter((actor) =>
      actor.address.startsWith(request.prefix) ||
      actor.label.toLowerCase().startsWith(request.prefix.toLowerCase())
    )
    .map((actor) => ({
      value: actor.address,
      label: actor.label || actor.address,
      detail: actor.label ? actor.address : undefined,
      kind: "actor" as const,
    }));

  request.cache.set(cacheKey, items);
  return items;
}

async function feedProvider(request: ProviderRequest): Promise<CompletionItem[]> {
  const signature = request.session.feeds.map((feed) => `${feed.id}:${feed.name ?? ""}`).join("|");
  const cacheKey = `feed:${signature}:${request.prefix}`;
  const cached = request.cache.get(cacheKey);
  if (cached) return cached;

  const items = request.session.feeds
    .filter((feed) =>
      feed.id.startsWith(request.prefix) ||
      (feed.name ?? "").toLowerCase().startsWith(request.prefix.toLowerCase())
    )
    .map((feed) => toFeedCompletionItem(feed));

  request.cache.set(cacheKey, items);
  return items;
}

function toFeedCompletionItem(feed: FeedEntry): CompletionItem {
  return {
    value: feed.id,
    label: feed.name || feed.id,
    detail: feed.name ? feed.id : undefined,
    kind: "feed",
  };
}

function normalizeInput(input: string, cursorOffset: number): NormalizedInput | null {
  if (cursorOffset < 0 || cursorOffset > input.length) {
    return null;
  }

  if (input.startsWith("/") && cursorOffset > 0) {
    return {
      value: input.slice(1),
      cursor: cursorOffset - 1,
      offset: 1,
    };
  }

  return {
    value: input,
    cursor: cursorOffset,
    offset: 0,
  };
}

function tokenizeWithSpans(input: string): TokenMatch[] {
  const tokens: TokenMatch[] = [];
  let current = "";
  let tokenStart = -1;
  let inQuote = false;
  let quoteChar = "";

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (inQuote) {
      if (char === quoteChar) {
        inQuote = false;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inQuote = true;
      quoteChar = char;
      if (tokenStart === -1) {
        tokenStart = index;
      }
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push({ value: current, start: tokenStart, end: index });
        current = "";
        tokenStart = -1;
      }
      continue;
    }

    if (tokenStart === -1) {
      tokenStart = index;
    }
    current += char;
  }

  if (current) {
    tokens.push({ value: current, start: tokenStart, end: input.length });
  }

  return tokens;
}

function findTokenAtCursor(input: string, tokens: TokenMatch[], cursorOffset: number): TokenInfo {
  const currentToken = tokens.find((token) => cursorOffset >= token.start && cursorOffset <= token.end);
  if (currentToken && cursorOffset < currentToken.end) {
    return {
      tokenStart: currentToken.start,
      tokenEnd: currentToken.end,
      prefix: input.slice(currentToken.start, cursorOffset),
      previousTokens: tokens.filter((token) => token.end <= currentToken.start).map((token) => token.value),
    };
  }

  if (currentToken && cursorOffset === currentToken.end && !hasTrailingWhitespace(input, cursorOffset)) {
    return {
      tokenStart: currentToken.start,
      tokenEnd: currentToken.end,
      prefix: currentToken.value,
      previousTokens: tokens.filter((token) => token.end <= currentToken.start).map((token) => token.value),
    };
  }

  return {
    tokenStart: cursorOffset,
    tokenEnd: cursorOffset,
    prefix: "",
    previousTokens: tokens.filter((token) => token.end <= cursorOffset).map((token) => token.value),
  };
}

function hasTrailingWhitespace(input: string, cursorOffset: number): boolean {
  if (cursorOffset === 0) return false;
  return /\s/.test(input[cursorOffset - 1] ?? "");
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

function getValueCacheKey(
  valueKind: CompletionValueKind,
  prefix: string,
  context: CompletionContext
): string {
  switch (valueKind.type) {
    case "path":
      return `path:${context.cwd}:${prefix}`;
    case "actor":
      return `actor:${context.session.actors.map((actor) => `${actor.address}:${actor.label}`).join("|")}:${prefix}`;
    case "feed":
      return `feed:${context.session.feeds.map((feed) => `${feed.id}:${feed.name ?? ""}`).join("|")}:${prefix}`;
    case "choice":
      return `choice:${valueKind.options.join("|")}:${prefix}`;
    default:
      return `${valueKind.type}:${prefix}`;
  }
}
