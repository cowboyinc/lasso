# Lasso markdown rendering + theme-safe command echo + AI status fix

**Date:** 2026-06-10
**Status:** Approved (Logan, 2026-06-10)
**Goal:** Agent/AI output renders Claude-Code-style markdown in the TUI,
command-echo lines are readable on light terminal themes, and the status bar's
AI indicator reflects the new dashboard-agent default.

## Context

Three problems surfaced in the 0.4.0 smoke test:

1. **Black bars:** the `command` case renders
   `<Text color="gray" backgroundColor="#1a1a1a">` — a hardcoded near-black
   background. On light terminal themes ANSI gray resolves dark, producing
   dark-on-dark (invisible until selected).
2. **Raw markdown:** the in-house renderer handles only `**bold**`,
   `` `inline code` ``, and fenced code blocks. Headings (`###`), bullets,
   numbered lists, italics, blockquotes, and rules pass through as raw text —
   the dashboard agent emits all of these.
3. **`AI: off` while AI works:** `StatusBar.tsx:33` keys the AI indicator
   solely on `runnerUrl`. After 0.4.0's default flip, the typical config has
   `dashboardUrl` set and `runnerUrl` unset — AI works via the agent but the
   status bar shows a red `AI: off`.

Scope decision (Logan): extend the in-house renderer to the CC-style core set.
No new dependencies (`marked-terminal` rejected: pulls cli-highlight, and its
dark-theme color defaults are the same bug class we're fixing).

## Design

### 1. Theme-safe command echo (`src/components/Message.tsx`)

The `command` case becomes `❯ <text>` rendered with `dimColor` and **no
background color**. Rule for this file henceforth: named ANSI styles only, no
hex backgrounds — they don't adapt to terminal themes.

### 2. Pure parser (`src/markdown.ts`, new)

```ts
export type InlineSpan = { style: "plain" | "bold" | "italic" | "code"; text: string };
export type MdBlock =
  | { kind: "paragraph"; spans: InlineSpan[] }
  | { kind: "heading"; level: number; spans: InlineSpan[] }
  | { kind: "bullet"; indent: number; spans: InlineSpan[] }
  | { kind: "ordered"; indent: number; number: string; spans: InlineSpan[] }
  | { kind: "quote"; spans: InlineSpan[] }
  | { kind: "hr" }
  | { kind: "code"; lines: string[] }
  | { kind: "blank" };

export function parseMarkdown(content: string): MdBlock[];
export function parseInline(text: string): InlineSpan[];
```

Line-based block grammar:

- `#{1,6} ` → heading (level = #-count)
- `[-*] ` (optionally indented) → bullet, indent preserved
- `\d+. ` (optionally indented) → ordered, original number kept
- `> ` → quote
- `---` / `***` / `___` (3+, alone on line) → hr
- ` ``` ` fences → code block; **unclosed fence flushes as code** (preserves
  current behavior — matters mid-stream since `streamingText` renders through
  the same path)
- otherwise → paragraph

Inline grammar: `**bold**` matched before `*italic*` / `_italic_` (so `**`
never half-matches as italic), `` `code` ``. Links/tables/syntax highlighting:
out of scope (render as plain text).

Preserved behaviors from the current renderer: consecutive blank lines
collapse to one; trailing blank lines trimmed.

Pure data in/out — no React, no I/O — unit-testable with `node:test`.

### 3. Thin render layer (`src/components/Message.tsx`)

`renderMarkdown`/`renderMarkdownLine` (the ad-hoc regex renderer) are deleted;
the `output` case maps `parseMarkdown(content)` to Ink elements:

| Block | Render |
| --- | --- |
| heading | bold cyan text (all levels) |
| bullet | `• ` + spans, indent preserved |
| ordered | `<number>. ` + spans, indent preserved |
| quote | dim italic |
| hr | dim `────────────────────` (fixed width) |
| code | unchanged: green lines in a padded Box |
| paragraph | inline spans (bold / italic / cyan code) |
| blank | empty line |

Inline span styles: plain → default; bold → `bold`; italic → `italic`;
code → `color="cyan"`.

### 4. AI status indicator (`src/components/StatusBar.tsx`, `src/app.tsx`)

`StatusBar` gains a `dashboardUrl: string | null` prop (passed from `app.tsx`
alongside the existing `runnerUrl`). The indicator shows the active mode
instead of a bare on/off:

- `dashboardUrl` set → `AI: dashboard` (green)
- else `runnerUrl` set → `AI: direct` (green)
- else → `AI: off` (red)

Mode mirrors `handlePromptSubmit`'s routing rule exactly, so the label can't
disagree with behavior.

### 5. Ship vehicle

Additional commits on `worktree-agent-backend` → lands in PR #28, plus
CHANGELOG 0.4.0 lines ("agent output renders markdown; command echo readable
on light themes; AI status shows the active backend mode").

### 6. Testing

- Parser unit tests (`src/markdown.test.ts`): headings, bullets/ordered with
  indent, bold-vs-italic disambiguation, inline code, quote, hr, unclosed
  fence, blank-line collapsing.
- `make check` green.
- Visual pass via `npm run dev`: re-ask the dual-gas question; verify headings,
  bullets, the command echo on a light theme, and `AI: dashboard` in the
  status bar (then `AI: off` with `"dashboard_url": ""` and no runner).
