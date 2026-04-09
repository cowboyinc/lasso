import { renderHelpText, COMMAND_SPECS } from "./schema.js";
import { findTokenAtCursor, normalizeInput, tokenizeWithSpans } from "./autocomplete/parser.js";
import { resolveMatchState } from "./autocomplete/matcher.js";
import { CompletionCache } from "./autocomplete/types.js";
import type {
  CompletionContext,
  CompletionItem,
  CompletionResult,
  CompletionProvider,
  TokenMatch,
} from "./autocomplete/types.js";

export type {
  CompletionContext,
  CompletionItem,
  CompletionProvider,
  CompletionResult,
  TokenMatch,
} from "./autocomplete/types.js";

export const HELP_TEXT = renderHelpText(COMMAND_SPECS);

export { CompletionCache, tokenizeCommandInput };

function tokenizeCommandInput(input: string): string[] {
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
