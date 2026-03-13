import type { SessionState } from "../../types.js";
import type { CompletionValueKind } from "../schema.js";

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

export interface ProviderRequest {
  prefix: string;
  cwd: string;
  session: SessionState;
  cache: CompletionCache;
}

export interface NormalizedInput {
  value: string;
  cursor: number;
  offset: number;
}

export interface TokenInfo {
  tokenStart: number;
  tokenEnd: number;
  prefix: string;
  previousTokens: string[];
}

export interface MatchState {
  kind: "literal" | "argument" | "flag" | "flag-value";
  items?: CompletionItem[];
  valueKind?: CompletionValueKind;
}

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
