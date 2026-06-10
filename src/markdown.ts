/**
 * Minimal markdown parser for TUI rendering — pure data in/out (no React,
 * no I/O) so it unit-tests with node:test. Message.tsx maps the blocks to
 * Ink elements. Scope (per the design spec): headings, bullets, ordered
 * lists, quotes, rules, fenced code, bold/italic/inline-code. Links and
 * tables intentionally render as plain text.
 */

export interface InlineSpan {
  style: "plain" | "bold" | "italic" | "code";
  text: string;
}

export type MdBlock =
  | { kind: "paragraph"; spans: InlineSpan[] }
  | { kind: "heading"; level: number; spans: InlineSpan[] }
  | { kind: "bullet"; indent: number; spans: InlineSpan[] }
  | { kind: "ordered"; indent: number; number: string; spans: InlineSpan[] }
  | { kind: "quote"; spans: InlineSpan[] }
  | { kind: "hr" }
  | { kind: "code"; lines: string[] }
  | { kind: "blank" };

/**
 * Split a line into styled spans. Alternation order matters: `**bold**`
 * before `*italic*` so a double asterisk never half-matches as italic.
 * Italic/underscore content must start and end with non-space, so prose
 * like "2 * 3 * 4" stays plain.
 */
export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  const pattern =
    /\*\*(.+?)\*\*|`([^`]+)`|\*(\S(?:[^*]*\S)?)\*|_(\S(?:[^_]*\S)?)_/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) {
      spans.push({ style: "plain", text: text.slice(last, m.index) });
    }
    if (m[1] !== undefined) {
      spans.push({ style: "bold", text: m[1] });
    } else if (m[2] !== undefined) {
      spans.push({ style: "code", text: m[2] });
    } else if (m[3] !== undefined) {
      spans.push({ style: "italic", text: m[3] });
    } else {
      spans.push({ style: "italic", text: m[4] });
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) {
    spans.push({ style: "plain", text: text.slice(last) });
  }
  return spans;
}

/**
 * Line-based block parser. Behaviors preserved from the previous ad-hoc
 * renderer: consecutive blank lines collapse to one, trailing blanks are
 * trimmed, and an unclosed code fence flushes as code (the streaming
 * render passes partial markdown through here on every token).
 */
export function parseMarkdown(content: string): MdBlock[] {
  const rawLines = content.split("\n");

  const lines: string[] = [];
  let lastWasEmpty = false;
  for (const line of rawLines) {
    const isEmpty = line.trim() === "";
    if (isEmpty && lastWasEmpty) continue;
    lines.push(line);
    lastWasEmpty = isEmpty;
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }

  const blocks: MdBlock[] = [];
  let inCode = false;
  let codeLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCode) {
        blocks.push({ kind: "code", lines: codeLines });
        codeLines = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (line.trim() === "") {
      blocks.push({ kind: "blank" });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        spans: parseInline(heading[2]),
      });
      continue;
    }

    // Before bullets: a rule like "---" must not be misread as a list item.
    const hr = line.match(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/);
    if (hr) {
      blocks.push({ kind: "hr" });
      continue;
    }

    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      blocks.push({
        kind: "bullet",
        indent: bullet[1].length,
        spans: parseInline(bullet[2]),
      });
      continue;
    }

    const ordered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (ordered) {
      blocks.push({
        kind: "ordered",
        indent: ordered[1].length,
        number: ordered[2],
        spans: parseInline(ordered[3]),
      });
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      blocks.push({ kind: "quote", spans: parseInline(quote[1]) });
      continue;
    }

    blocks.push({ kind: "paragraph", spans: parseInline(line) });
  }

  if (inCode && codeLines.length > 0) {
    blocks.push({ kind: "code", lines: codeLines });
  }

  return blocks;
}
