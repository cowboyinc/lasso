import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import type { FeedEntry } from "../../types.js";
import type { CompletionContext, CompletionItem, ProviderRequest } from "./types.js";

export async function resolveValueItems(
  valueKind: { type: string; options?: string[] },
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
      items = (valueKind.options ?? [])
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

export async function pathProvider(request: ProviderRequest): Promise<CompletionItem[]> {
  const prefix = request.prefix;
  const cacheKey = `path:${request.cwd}:${prefix}`;
  const cached = request.cache.get(cacheKey);
  if (cached) return cached;

  const inputPath = prefix || "";
  const endsInSeparator = inputPath.endsWith("/");
  const hasDirectorySegments = inputPath.includes("/");
  const baseDir = endsInSeparator
    ? inputPath.slice(0, -1) || "."
    : hasDirectorySegments
      ? dirname(inputPath)
      : ".";
  const fragment = endsInSeparator ? "" : hasDirectorySegments ? basename(inputPath) : inputPath;
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

export async function actorProvider(request: ProviderRequest): Promise<CompletionItem[]> {
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

export async function feedProvider(request: ProviderRequest): Promise<CompletionItem[]> {
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

function getValueCacheKey(
  valueKind: { type: string; options?: string[] },
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
      return `choice:${(valueKind.options ?? []).join("|")}:${prefix}`;
    default:
      return `${valueKind.type}:${prefix}`;
  }
}
