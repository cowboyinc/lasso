import type { NormalizedInput, TokenInfo, TokenMatch } from "./types.js";

export function normalizeInput(input: string, cursorOffset: number): NormalizedInput | null {
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

export function tokenizeWithSpans(input: string): TokenMatch[] {
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

export function findTokenAtCursor(input: string, tokens: TokenMatch[], cursorOffset: number): TokenInfo {
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
