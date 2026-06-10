# Markdown Rendering + Theme-Safe Echo + AI Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lasso renders agent output as Claude-Code-style markdown, command echoes are readable on light terminal themes, and the status bar's AI indicator reflects the active backend mode.

**Architecture:** A pure line-based parser (`src/markdown.ts`, data in/out, no React) produces typed blocks; `Message.tsx` shrinks to a thin block→Ink map and loses its hardcoded-background command style; `StatusBar.tsx` derives the AI mode from `dashboardUrl`/`runnerUrl` exactly like the prompt-routing rule.

**Tech Stack:** TypeScript ESM, Ink (React TUI), `node:test` via tsx (`npm test`), `make check` = tsc + tests.

**Spec:** `docs/superpowers/specs/2026-06-10-lasso-markdown-render-design.md`

**Working directory:** `/Users/l/cowboy/lasso/.claude/worktrees/agent-backend` (branch `worktree-agent-backend`, open PR #28). 62 tests currently pass.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/markdown.ts` (create) | Pure markdown parser: `parseMarkdown(content): MdBlock[]`, `parseInline(text): InlineSpan[]`. No React, no I/O. |
| `src/markdown.test.ts` (create) | Parser unit tests. |
| `src/components/Message.tsx` (modify) | Command echo without background color; `output` case maps `MdBlock[]` to Ink elements; old ad-hoc renderer deleted. |
| `src/components/StatusBar.tsx` (modify) | `dashboardUrl` prop; `AI: dashboard / direct / off`. |
| `src/app.tsx` (modify) | Pass `dashboardUrl` to StatusBar (one line). |
| `CHANGELOG.md` (modify) | Two 0.4.0 lines. |

---

### Task 1: Pure markdown parser (`src/markdown.ts`)

**Files:**
- Create: `src/markdown.ts`
- Test: `src/markdown.test.ts`

- [ ] **Step 1.1: Write the failing tests.** Create `src/markdown.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { parseInline, parseMarkdown } from "./markdown.js";

test("parseInline: bold, italic, code, and plain segments", () => {
  assert.deepEqual(parseInline("a **b** *c* _d_ `e` f"), [
    { style: "plain", text: "a " },
    { style: "bold", text: "b" },
    { style: "plain", text: " " },
    { style: "italic", text: "c" },
    { style: "plain", text: " " },
    { style: "italic", text: "d" },
    { style: "plain", text: " " },
    { style: "code", text: "e" },
    { style: "plain", text: " f" },
  ]);
});

test("parseInline: double asterisks parse as bold, not italic", () => {
  assert.deepEqual(parseInline("**bold**"), [{ style: "bold", text: "bold" }]);
});

test("parseInline: spaced asterisks are not italics", () => {
  assert.deepEqual(parseInline("2 * 3 * 4"), [
    { style: "plain", text: "2 * 3 * 4" },
  ]);
});

test("parseMarkdown: headings carry level and inline styles", () => {
  assert.deepEqual(parseMarkdown("### Total **Fee** Formula"), [
    {
      kind: "heading",
      level: 3,
      spans: [
        { style: "plain", text: "Total " },
        { style: "bold", text: "Fee" },
        { style: "plain", text: " Formula" },
      ],
    },
  ]);
});

test("parseMarkdown: bullets and ordered items keep indent and number", () => {
  assert.deepEqual(parseMarkdown("- one\n  - nested\n3. third"), [
    { kind: "bullet", indent: 0, spans: [{ style: "plain", text: "one" }] },
    { kind: "bullet", indent: 2, spans: [{ style: "plain", text: "nested" }] },
    { kind: "ordered", indent: 0, number: "3", spans: [{ style: "plain", text: "third" }] },
  ]);
});

test("parseMarkdown: quotes and horizontal rules", () => {
  assert.deepEqual(parseMarkdown("> note\n---"), [
    { kind: "quote", spans: [{ style: "plain", text: "note" }] },
    { kind: "hr" },
  ]);
});

test("parseMarkdown: fenced code passes through unparsed", () => {
  assert.deepEqual(parseMarkdown("```python\n- not a bullet\n```"), [
    { kind: "code", lines: ["- not a bullet"] },
  ]);
});

test("parseMarkdown: unclosed fence flushes as code (mid-stream)", () => {
  assert.deepEqual(parseMarkdown("text\n```\ncode so far"), [
    { kind: "paragraph", spans: [{ style: "plain", text: "text" }] },
    { kind: "code", lines: ["code so far"] },
  ]);
});

test("parseMarkdown: consecutive blanks collapse, trailing blanks trimmed", () => {
  assert.deepEqual(parseMarkdown("a\n\n\n\nb\n\n"), [
    { kind: "paragraph", spans: [{ style: "plain", text: "a" }] },
    { kind: "blank" },
    { kind: "paragraph", spans: [{ style: "plain", text: "b" }] },
  ]);
});
```

- [ ] **Step 1.2: Run tests to verify they fail.** `npm test 2>&1 | tail -10` — expect FAIL: cannot find module './markdown.js'.

- [ ] **Step 1.3: Create `src/markdown.ts`:**

```ts
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
```

- [ ] **Step 1.4: Run tests to verify they pass.** `npm test 2>&1 | tail -6` — expect 71 pass / 0 fail (62 existing + 9 new).

- [ ] **Step 1.5: Commit:**

```bash
git add src/markdown.ts src/markdown.test.ts
git commit -m "feat: pure markdown parser for TUI rendering"
```

---

### Task 2: Message.tsx — theme-safe echo + block renderer

**Files:**
- Modify: `src/components/Message.tsx` (full rewrite below)

No new unit test — the parser carries the logic and is tested; this is a thin Ink map. Verify with `make check` + the visual pass in Task 3.

- [ ] **Step 2.1: Replace the entire contents of `src/components/Message.tsx` with:**

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { ConsoleMessage } from "../types.js";
import { parseMarkdown } from "../markdown.js";
import type { InlineSpan, MdBlock } from "../markdown.js";

// Styling rule for this file: named ANSI styles only — never hex
// backgrounds. They don't adapt to the user's terminal theme (a hardcoded
// #1a1a1a background made command echoes unreadable on light themes).

interface MessageProps {
  message: ConsoleMessage;
}

function renderSpans(spans: InlineSpan[]): React.ReactNode {
  return spans.map((span, i) => {
    switch (span.style) {
      case "bold":
        return (
          <Text key={i} bold>
            {span.text}
          </Text>
        );
      case "italic":
        return (
          <Text key={i} italic>
            {span.text}
          </Text>
        );
      case "code":
        return (
          <Text key={i} color="cyan">
            {span.text}
          </Text>
        );
      default:
        return <Text key={i}>{span.text}</Text>;
    }
  });
}

function renderBlock(block: MdBlock, key: number): React.ReactNode {
  switch (block.kind) {
    case "heading":
      return (
        <Text key={key} bold color="cyan">
          {renderSpans(block.spans)}
        </Text>
      );
    case "bullet":
      return (
        <Text key={key}>
          {" ".repeat(block.indent)}• {renderSpans(block.spans)}
        </Text>
      );
    case "ordered":
      return (
        <Text key={key}>
          {" ".repeat(block.indent)}
          {block.number}. {renderSpans(block.spans)}
        </Text>
      );
    case "quote":
      return (
        <Text key={key} dimColor italic>
          {renderSpans(block.spans)}
        </Text>
      );
    case "hr":
      return (
        <Text key={key} dimColor>
          {"─".repeat(20)}
        </Text>
      );
    case "code":
      return (
        <Box key={key} flexDirection="column" paddingX={1}>
          {block.lines.map((cl, ci) => (
            <Text key={ci} color="green">
              {cl}
            </Text>
          ))}
        </Box>
      );
    case "blank":
      return <Text key={key}> </Text>;
    case "paragraph":
      return <Text key={key}>{renderSpans(block.spans)}</Text>;
  }
}

function renderMarkdown(content: string): React.ReactNode {
  return <>{parseMarkdown(content).map((block, i) => renderBlock(block, i))}</>;
}

export function Message({ message }: MessageProps) {
  switch (message.role) {
    case "command":
      return (
        <Box paddingX={1}>
          <Text dimColor>
            {"❯ "}
            {message.content}
          </Text>
        </Box>
      );

    case "output":
      return (
        <Box paddingX={1} flexDirection="column">
          {renderMarkdown(message.content)}
        </Box>
      );

    case "error":
      return (
        <Box paddingX={1}>
          <Text color="red">{message.content}</Text>
        </Box>
      );

    case "system":
      return (
        <Box paddingX={1}>
          <Text color="yellow">{message.content}</Text>
        </Box>
      );
  }
}
```

- [ ] **Step 2.2: Verify.** `make check 2>&1 | tail -6` — typecheck clean, 71 pass / 0 fail.

- [ ] **Step 2.3: Commit:**

```bash
git add src/components/Message.tsx
git commit -m "feat: CC-style markdown render; theme-safe command echo"
```

---

### Task 3: AI status indicator + CHANGELOG + push

**Files:**
- Modify: `src/components/StatusBar.tsx`
- Modify: `src/app.tsx:1352-1359` (StatusBar invocation)
- Modify: `CHANGELOG.md`

- [ ] **Step 3.1: Update `src/components/StatusBar.tsx`.** Add the prop and mode derivation; the full updated file:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { VERSION } from "../constants.js";
import type { RunnerPreferences } from "../types.js";

interface StatusBarProps {
  validatorUrl: string;
  hasKey: boolean;
  walletAddress: string | null;
  cowboyVersion: string | null;
  runnerPreferences: RunnerPreferences;
  runnerUrl: string | null;
  dashboardUrl: string | null;
}

export function StatusBar({ validatorUrl, hasKey, walletAddress, cowboyVersion, runnerPreferences, runnerUrl, dashboardUrl }: StatusBarProps) {
  const shortWallet = walletAddress
    ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`
    : null;

  // Mirrors handlePromptSubmit's routing rule: dashboard agent first,
  // direct runner second — so the label can't disagree with behavior.
  const aiMode = dashboardUrl ? "dashboard" : runnerUrl ? "direct" : "off";

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text dimColor>
        Network: <Text color="cyan">{validatorUrl}</Text>
        {"  "}|{"  "}
        Key: <Text color={hasKey ? "green" : "red"}>{hasKey ? "set" : "not set"}</Text>
        {shortWallet && (
          <>
            {"  "}|{"  "}
            Wallet: <Text color="yellow">{shortWallet}</Text>
          </>
        )}
        {"  "}|{"  "}
        AI: <Text color={aiMode === "off" ? "red" : "green"}>{aiMode}</Text>
      </Text>
      <Text dimColor>
        {cowboyVersion && <>cli v{cowboyVersion}{"  "}|{"  "}</>}
        lasso v{VERSION}
      </Text>
    </Box>
  );
}
```

- [ ] **Step 3.2: Pass the prop in `src/app.tsx`.** The StatusBar invocation (~line 1352) gains one line after `runnerUrl={session.runnerUrl}`:

```tsx
      <StatusBar
        validatorUrl={session.validatorUrl}
        hasKey={projectReady}
        walletAddress={session.walletAddress}
        cowboyVersion={cowboyVersion}
        runnerPreferences={session.runnerPreferences}
        runnerUrl={session.runnerUrl}
        dashboardUrl={session.dashboardUrl}
      />
```

- [ ] **Step 3.3: CHANGELOG.** In the `## [0.4.0]` section's `### Changed` list, append two bullets:

```markdown
- Agent output renders markdown (headings, bullet/numbered lists, italics,
  quotes, rules — on top of the existing bold/inline-code/code blocks), and
  the command echo no longer uses a hardcoded dark background that was
  unreadable on light terminal themes.
- The status bar AI indicator shows the active backend (`AI: dashboard`,
  `AI: direct`, or `AI: off`) instead of keying on `runner_url` alone.
```

- [ ] **Step 3.4: Verify.** `make check 2>&1 | tail -6` — typecheck clean, 71 pass / 0 fail.

- [ ] **Step 3.5: Commit and push (updates PR #28):**

```bash
git add src/components/StatusBar.tsx src/app.tsx CHANGELOG.md
git commit -m "feat: AI status shows active backend mode (dashboard/direct/off)"
git push
```

---

## Post-plan

Visual pass (controller/user, real terminal): `npm run dev` from the worktree (it has a `.cowboy/config.json`); re-ask the dual-gas question — expect cyan-bold headings, `•` bullets, readable `❯` command echo, and `AI: dashboard` in the status bar; then set `"dashboard_url": ""` (no runner) and confirm `AI: off`.
