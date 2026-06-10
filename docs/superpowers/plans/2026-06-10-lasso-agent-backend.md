# Lasso AI Builder → Dashboard Backend Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lasso's plain-text AI flow becomes a second client of the dashboard agent loop, streaming `POST /api/agent/chat` SSE events from `https://dashboard.mesa.cowboylabs.net` exactly like the dashboard frontend, with `write_actor` results written to local files.

**Architecture:** A protocol module (`src/agent-client.ts`) speaks the SSE event protocol (types ported verbatim from `dashboard/frontend/src/lib/agent/events.ts` and `sse-client.ts`). A turn-runner (`src/agent-turn.ts`) maps events to injected UI callbacks — pure logic, fully unit-testable. `src/app.tsx` glues them in with a routing rule: `dashboardUrl` set → agent path; else `runnerUrl` → existing direct-vLLM path (untouched); else setup error.

**Tech Stack:** TypeScript ESM, Ink (React TUI), native `fetch`/`ReadableStream`, `node:test` + `assert/strict` (run via `make check` = `tsc --noEmit` + `npm test`).

**Spec:** `docs/superpowers/specs/2026-06-10-lasso-agent-backend-design.md`

**Working directory:** `/Users/l/cowboy/lasso/.claude/worktrees/agent-backend` (branch `worktree-agent-backend`). Run all commands from here.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/agent-client.ts` (create) | Protocol: `AgentEvent` types, `parseEventStream` (SSE bytes → events), `createConversation`, `streamAgentChat`. No UI knowledge. |
| `src/agent-client.test.ts` (create) | Parser tests (chunk-split frames, malformed frames) + fetch-mocked endpoint tests. |
| `src/agent-turn.ts` (create) | `runAgentTurn(events, io)` — event → UI-action mapping with injected callbacks. No fs, no fetch, no React. |
| `src/agent-turn.test.ts` (create) | Turn tests with synthetic event generators. |
| `src/actor-extractor.ts` (modify) | Export `actorFromCode(rawCode)` (shim + class name + path); `extractActors` refactored to use it. |
| `src/actor-extractor.test.ts` (create) | Tests for `actorFromCode`. |
| `src/config.ts` (modify) | `DEFAULT_DASHBOARD_URL`; `dashboard_url` absent → default, `""` → opt-out (null). |
| `src/config.test.ts` (modify) | Tests for the three dashboard_url cases. |
| `src/cli.tsx` (modify) | `DEFAULT_CONFIG.dashboardUrl` = default mesa URL. |
| `src/app.tsx` (modify) | Routing + agent branch in `handlePromptSubmit`; abort wiring in `handleInterrupt`. |
| `CHANGELOG.md`, `README.md`, `package.json` (modify) | 0.4.0 entry, config docs, version bump. |

Protocol contracts (verified against source on 2026-06-10):
- `POST {base}/api/conversations` body `{"wallet","kind":"builder","firstMessage"}` → `{"conversation":{"id":...}}` (`dashboard/backend/src/routes/conversations.ts:80`; the dashboard creates agent conversations with `kind:"builder"`, `ChatLauncher.tsx:78`).
- `POST {base}/api/agent/chat` body `{"conversationId","content"}` → SSE stream, frames are `data: <json>` separated by `\n\n` (`dashboard/backend/src/routes/agent.ts:1805`).
- `write_actor` `tool_result.output`: `{status:"ok"|"error", language:"python", code:string, warnings:string[], notes:string}` (`dashboard/backend/src/agent/tools/write-actor.ts`).

---

### Task 1: SSE event types + stream parser (`src/agent-client.ts`)

**Files:**
- Create: `src/agent-client.ts`
- Test: `src/agent-client.test.ts`

- [ ] **Step 1.1: Write the failing parser tests**

Create `src/agent-client.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { parseEventStream } from "./agent-client.js";
import type { AgentEvent } from "./agent-client.js";

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of parseEventStream(body)) events.push(ev);
  return events;
}

test("parseEventStream parses data frames separated by blank lines", async () => {
  const events = await collect(
    streamFromChunks([
      'data: {"type":"stream_start","seq":0,"ts":1,"protocol":1,"conversationId":"c1","sessionId":"s1","model":"cowboy-actor"}\n\n',
      'data: {"type":"text_delta","seq":1,"ts":2,"iteration":0,"delta":"howdy"}\n\n',
      'data: {"type":"done","seq":2,"ts":3,"totalIterations":1,"finalAssistantContent":"howdy"}\n\n',
    ])
  );
  assert.equal(events.length, 3);
  assert.equal(events[0].type, "stream_start");
  assert.equal(events[1].type, "text_delta");
  assert.equal((events[2] as { finalAssistantContent: string }).finalAssistantContent, "howdy");
});

test("parseEventStream handles frames split across chunk boundaries", async () => {
  const frame = 'data: {"type":"text_delta","seq":0,"ts":1,"iteration":0,"delta":"split"}\n\n';
  const events = await collect(
    streamFromChunks([frame.slice(0, 25), frame.slice(25, 40), frame.slice(40)])
  );
  assert.equal(events.length, 1);
  assert.equal((events[0] as { delta: string }).delta, "split");
});

test("parseEventStream skips non-data frames, malformed JSON, and CRLF noise", async () => {
  const events = await collect(
    streamFromChunks([
      ": keepalive comment\n\n",
      "data: {not json}\n\n",
      'data: {"type":"text_delta","seq":0,"ts":1,"iteration":0,"delta":"ok"}\r\n\n',
    ])
  );
  assert.equal(events.length, 1);
  assert.equal((events[0] as { delta: string }).delta, "ok");
});
```

- [ ] **Step 1.2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module './agent-client.js'` (or similar ERR_MODULE_NOT_FOUND).

- [ ] **Step 1.3: Create `src/agent-client.ts` with event types and parser**

```ts
/**
 * Agent protocol client — lasso-side mirror of the dashboard agent stream.
 *
 * Event types ported verbatim from
 * dashboard/frontend/src/lib/agent/events.ts (itself a mirror of
 * dashboard/backend/src/agent/events.ts). Keep in sync — there is no
 * shared-types package today.
 */

export const AGENT_PROTOCOL_VERSION = 1;

export type AgentEvent =
  | StreamStartEvent
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ToolUseStartEvent
  | ToolUseInputDeltaEvent
  | ToolOutputDeltaEvent
  | ToolUseEndEvent
  | ToolResultEvent
  | ToolPendingSignatureEvent
  | IterationStartEvent
  | IterationEndEvent
  | ErrorEvent
  | DoneEvent;

interface BaseEvent {
  seq: number;
  ts: number;
}

export interface StreamStartEvent extends BaseEvent {
  type: "stream_start";
  protocol: number;
  conversationId: string;
  sessionId: string;
  model: string;
}

export interface IterationStartEvent extends BaseEvent {
  type: "iteration_start";
  iteration: number;
}

export interface IterationEndEvent extends BaseEvent {
  type: "iteration_end";
  iteration: number;
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "max_iters" | "error";
}

export interface TextDeltaEvent extends BaseEvent {
  type: "text_delta";
  iteration: number;
  delta: string;
}

/** Chain-of-thought tokens from a reasoning runner. NOT part of the answer. */
export interface ReasoningDeltaEvent extends BaseEvent {
  type: "reasoning_delta";
  iteration: number;
  delta: string;
}

export interface ToolUseStartEvent extends BaseEvent {
  type: "tool_use_start";
  iteration: number;
  toolUseId: string;
  toolName: string;
  displayName?: string;
}

export interface ToolUseInputDeltaEvent extends BaseEvent {
  type: "tool_use_input_delta";
  iteration: number;
  toolUseId: string;
  delta: string;
}

export interface ToolOutputDeltaEvent extends BaseEvent {
  type: "tool_output_delta";
  iteration: number;
  toolUseId: string;
  channel: "draft" | "repair" | "log";
  delta: string;
}

export interface ToolUseEndEvent extends BaseEvent {
  type: "tool_use_end";
  iteration: number;
  toolUseId: string;
  input: unknown;
}

export interface ToolResultEvent extends BaseEvent {
  type: "tool_result";
  iteration: number;
  toolUseId: string;
  status: "ok" | "error";
  output: unknown;
  summary?: string;
  durationMs: number;
}

export interface ToolPendingSignatureEvent extends BaseEvent {
  type: "tool_pending_signature";
  iteration: number;
  toolUseId: string;
  preview: {
    kind: "deploy" | "message" | "transfer";
    summary: string;
    estCycles?: number;
    estCells?: number;
    maxFeeCby?: string;
    payload: unknown;
  };
}

export interface ErrorEvent extends BaseEvent {
  type: "error";
  iteration?: number;
  toolUseId?: string;
  message: string;
  recoverable: boolean;
}

export interface DoneEvent extends BaseEvent {
  type: "done";
  totalIterations: number;
  finalAssistantContent: string;
  truncated?: boolean;
}

/**
 * Parse an SSE byte stream into AgentEvents. Frames are separated by a
 * blank line; only `data:` lines carry events. Ported from
 * dashboard/frontend/src/lib/agent/sse-client.ts.
 */
export async function* parseEventStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<AgentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const event = parseFrame(frame);
        if (event) yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(frame: string): AgentEvent | null {
  let dataLine: string | null = null;
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("data:")) {
      dataLine = line.slice(5).trim();
    }
  }
  if (!dataLine) return null;
  try {
    return JSON.parse(dataLine) as AgentEvent;
  } catch {
    return null;
  }
}
```

- [ ] **Step 1.4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -20`
Expected: PASS — 3 new tests green, all 35 existing tests still green (38 total).

- [ ] **Step 1.5: Commit**

```bash
git add src/agent-client.ts src/agent-client.test.ts
git commit -m "feat: agent SSE protocol types + stream parser"
```

---

### Task 2: `createConversation` + `streamAgentChat` (`src/agent-client.ts`)

**Files:**
- Modify: `src/agent-client.ts` (append)
- Test: `src/agent-client.test.ts` (append)

- [ ] **Step 2.1: Write the failing endpoint tests**

Append to `src/agent-client.test.ts`:

```ts
import { createConversation, streamAgentChat } from "./agent-client.js";

test("createConversation posts wallet/kind/firstMessage and returns the id", async () => {
  const realFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody: unknown = null;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ conversation: { id: "conv-42" } }), {
      status: 200,
    });
  }) as typeof fetch;

  try {
    const id = await createConversation(
      "https://dashboard.mesa.cowboylabs.net/",
      "0xabc",
      "build a counter"
    );
    assert.equal(id, "conv-42");
    assert.equal(
      capturedUrl,
      "https://dashboard.mesa.cowboylabs.net/api/conversations"
    );
    assert.deepEqual(capturedBody, {
      wallet: "0xabc",
      kind: "builder",
      firstMessage: "build a counter",
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("createConversation throws a descriptive error on non-200", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("wallet and kind required", { status: 400 })) as typeof fetch;
  try {
    await assert.rejects(
      () => createConversation("https://x.test", "0xabc", "hi"),
      /create conversation 400: wallet and kind required/
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("streamAgentChat posts conversationId/content and yields parsed events", async () => {
  const realFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody: unknown = null;
  const sse =
    'data: {"type":"text_delta","seq":0,"ts":1,"iteration":0,"delta":"yee"}\n\n' +
    'data: {"type":"done","seq":1,"ts":2,"totalIterations":1,"finalAssistantContent":"yee"}\n\n';
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(String(init?.body));
    return new Response(sse, { status: 200 });
  }) as typeof fetch;

  try {
    const handle = streamAgentChat("https://x.test", {
      conversationId: "conv-42",
      content: "build a counter",
    });
    const events: string[] = [];
    for await (const ev of handle.events) events.push(ev.type);
    assert.deepEqual(events, ["text_delta", "done"]);
    assert.equal(capturedUrl, "https://x.test/api/agent/chat");
    assert.deepEqual(capturedBody, {
      conversationId: "conv-42",
      content: "build a counter",
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("streamAgentChat throws a descriptive error on non-200", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("conversation not found", { status: 404 })) as typeof fetch;
  try {
    const handle = streamAgentChat("https://x.test", {
      conversationId: "nope",
      content: "hi",
    });
    await assert.rejects(async () => {
      for await (const ev of handle.events) void ev;
    }, /agent chat 404: conversation not found/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
```

- [ ] **Step 2.2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `createConversation`/`streamAgentChat` not exported.

- [ ] **Step 2.3: Append the implementations to `src/agent-client.ts`**

```ts
export interface AgentChatRequest {
  conversationId: string;
  content: string;
  /** When true, restrict the agent to read-only research. Unused by lasso today. */
  planMode?: boolean;
  /** Optional model id. Omitted: the server resolves its default. */
  model?: string;
}

export interface StreamHandle {
  /** Async iterable of parsed events. */
  events: AsyncGenerator<AgentEvent>;
  /** Aborts the in-flight request and closes the stream. */
  abort: () => void;
}

/**
 * Create a builder conversation scoped to the wallet. Mirrors the dashboard
 * frontend (ChatLauncher.tsx): POST /api/conversations, kind "builder".
 */
export async function createConversation(
  dashboardUrl: string,
  wallet: string,
  firstMessage: string
): Promise<string> {
  const base = dashboardUrl.replace(/\/$/, "");
  const response = await fetch(`${base}/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet, kind: "builder", firstMessage }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`create conversation ${response.status}: ${text.slice(0, 300)}`);
  }
  const data = (await response.json()) as { conversation?: { id?: string } };
  const id = data.conversation?.id;
  if (!id) {
    throw new Error("create conversation: malformed response (no conversation.id)");
  }
  return id;
}

/**
 * Stream one agent turn. Mirrors the dashboard frontend's sse-client.ts,
 * with the dashboard URL made explicit (lasso is not same-origin).
 */
export function streamAgentChat(
  dashboardUrl: string,
  req: AgentChatRequest,
  init: { signal?: AbortSignal } = {}
): StreamHandle {
  const controller = new AbortController();
  if (init.signal) {
    init.signal.addEventListener("abort", () => controller.abort());
  }

  async function* generate(): AsyncGenerator<AgentEvent> {
    const base = dashboardUrl.replace(/\/$/, "");
    const response = await fetch(`${base}/api/agent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`agent chat ${response.status}: ${text.slice(0, 300)}`);
    }
    if (!response.body) {
      throw new Error("agent chat: empty response body");
    }
    yield* parseEventStream(response.body);
  }

  return { events: generate(), abort: () => controller.abort() };
}
```

- [ ] **Step 2.4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -20`
Expected: PASS — 7 agent-client tests green, everything else still green (42 total).

- [ ] **Step 2.5: Commit**

```bash
git add src/agent-client.ts src/agent-client.test.ts
git commit -m "feat: createConversation + streamAgentChat against dashboard backend"
```

---

### Task 3: `actorFromCode` (`src/actor-extractor.ts`)

**Files:**
- Modify: `src/actor-extractor.ts`
- Test: `src/actor-extractor.test.ts` (create)

- [ ] **Step 3.1: Write the failing tests**

Create `src/actor-extractor.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { actorFromCode, extractActors } from "./actor-extractor.js";

const COUNTER_CODE = `from cowboy import actor

@actor
class CounterActor:
    def init(self, payload):
        self.storage["count"] = 0

    def increment(self, payload):
        self.storage["count"] += 1
        return str(self.storage["count"]).encode()
`;

test("actorFromCode derives snake_case path from the class name", () => {
  const actor = actorFromCode(COUNTER_CODE);
  assert.equal(actor.className, "CounterActor");
  assert.equal(actor.filePath, "actors/counter/main.py");
});

test("actorFromCode appends the module-level dispatch shim", () => {
  const actor = actorFromCode(COUNTER_CODE);
  assert.match(actor.code, /_actor = CounterActor\(\)/);
  assert.match(actor.code, /def increment\(payload\)/);
});

test("actorFromCode falls back to actors/actor/main.py without a class", () => {
  const actor = actorFromCode(`def init(payload):\n    return b"ok"\n`);
  assert.equal(actor.className, null);
  assert.equal(actor.filePath, "actors/actor/main.py");
});

test("extractActors still extracts fenced python blocks", () => {
  const text = "Here you go:\n```python\n" + COUNTER_CODE + "```\n";
  const actors = extractActors(text);
  assert.equal(actors.length, 1);
  assert.equal(actors[0].filePath, "actors/counter/main.py");
});
```

- [ ] **Step 3.2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `actorFromCode` is not exported.

- [ ] **Step 3.3: Refactor `src/actor-extractor.ts`**

Replace the existing `extractActors` function (lines 14–32) with:

```ts
/**
 * Build an ExtractedActor from raw Python source: ensure the dispatch
 * shim, read the class name, derive the snake_case file path. Used both
 * for fenced code blocks (legacy direct-vLLM path) and for write_actor
 * tool results from the dashboard agent (which carry code but no path).
 */
export function actorFromCode(rawCode: string): ExtractedActor {
  const code = ensureDispatchShim(rawCode);
  const className = extractClassName(code);
  const name = className
    ? className.replace(/Actor$/, "").replace(/([A-Z])/g, "_$1").replace(/^_/, "").toLowerCase()
    : "actor";
  return {
    className,
    code,
    filePath: `actors/${name}/main.py`,
  };
}

/**
 * Extract Python code blocks from LLM text, add dispatch shims,
 * and derive file paths from class names.
 */
export function extractActors(text: string): ExtractedActor[] {
  return extractPythonCodeBlocks(text).map(actorFromCode);
}
```

(Everything below — `extractPythonCodeBlocks`, `extractClassName`, `ensureDispatchShim` — stays unchanged.)

- [ ] **Step 3.4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -20`
Expected: PASS — 4 new tests green (46 total).

- [ ] **Step 3.5: Commit**

```bash
git add src/actor-extractor.ts src/actor-extractor.test.ts
git commit -m "refactor: expose actorFromCode for pathless write_actor output"
```

---

### Task 4: `dashboard_url` default + opt-out (`src/config.ts`, `src/cli.tsx`)

**Files:**
- Modify: `src/config.ts`
- Modify: `src/cli.tsx:27-38`
- Test: `src/config.test.ts` (append)

- [ ] **Step 4.1: Write the failing tests**

Append to `src/config.test.ts` (reuse the temp-dir pattern already in the file):

```ts
import { DEFAULT_DASHBOARD_URL } from "./config.js";

function withTempConfig(
  contents: Record<string, unknown>,
  fn: () => void
): void {
  const previousCwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "lasso-config-"));
  try {
    mkdirSync(join(dir, ".cowboy"));
    writeFileSync(
      join(dir, ".cowboy", "config.json"),
      JSON.stringify(contents, null, 2)
    );
    process.chdir(dir);
    fn();
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("dashboard_url defaults to the mesa dashboard when absent", () => {
  withTempConfig({ rpc_url: "https://rpc.mesa.cowboylabs.net" }, () => {
    const config = loadProjectConfig();
    assert.ok(config);
    assert.equal(config.dashboardUrl, DEFAULT_DASHBOARD_URL);
    assert.equal(DEFAULT_DASHBOARD_URL, "https://dashboard.mesa.cowboylabs.net");
  });
});

test("dashboard_url empty string opts out (direct-runner mode)", () => {
  withTempConfig(
    { rpc_url: "https://rpc.mesa.cowboylabs.net", dashboard_url: "" },
    () => {
      const config = loadProjectConfig();
      assert.ok(config);
      assert.equal(config.dashboardUrl, null);
    }
  );
});

test("dashboard_url explicit value is normalized and used", () => {
  withTempConfig(
    { rpc_url: "https://rpc.mesa.cowboylabs.net", dashboard_url: "localhost:8000" },
    () => {
      const config = loadProjectConfig();
      assert.ok(config);
      assert.equal(config.dashboardUrl, "http://localhost:8000");
    }
  );
});
```

- [ ] **Step 4.2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `DEFAULT_DASHBOARD_URL` not exported (first test errors at import time).

- [ ] **Step 4.3: Implement in `src/config.ts`**

After the `DEFAULT_RPC_URL` line (line 5), add:

```ts
export const DEFAULT_DASHBOARD_URL = "https://dashboard.mesa.cowboylabs.net";

/**
 * dashboard_url resolution: absent → mesa default (agent mode out of the
 * box); explicitly "" (or null) → opt out, fall back to direct runner_url
 * mode; any other string → normalized as given.
 */
function resolveDashboardUrl(raw: unknown): string | null {
  if (raw === undefined) return DEFAULT_DASHBOARD_URL;
  if (typeof raw !== "string") return null;
  return normalizeEndpointUrl(raw);
}
```

In `loadProjectConfig`, replace the `dashboardUrl:` line (line 97):

```ts
      dashboardUrl: resolveDashboardUrl(target.dashboard_url),
```

- [ ] **Step 4.4: Update `src/cli.tsx`**

Change the import (line 7):

```ts
import { loadProjectConfig, DEFAULT_DASHBOARD_URL } from "./config.js";
```

In `DEFAULT_CONFIG` (line 29), change `dashboardUrl: null,` to:

```ts
  dashboardUrl: DEFAULT_DASHBOARD_URL,
```

- [ ] **Step 4.5: Run typecheck + tests to verify they pass**

Run: `make check 2>&1 | tail -10`
Expected: typecheck clean; PASS — 3 new tests green (49 total).

- [ ] **Step 4.6: Commit**

```bash
git add src/config.ts src/config.test.ts src/cli.tsx
git commit -m "feat: dashboard_url defaults to mesa dashboard; empty string opts out"
```

---

### Task 5: `runAgentTurn` event mapping (`src/agent-turn.ts`)

**Files:**
- Create: `src/agent-turn.ts`
- Test: `src/agent-turn.test.ts`

- [ ] **Step 5.1: Write the failing tests**

Create `src/agent-turn.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { runAgentTurn } from "./agent-turn.js";
import type { AgentTurnIO } from "./agent-turn.js";
import type { AgentEvent } from "./agent-client.js";
import type { ExtractedActor } from "./actor-extractor.js";

async function* eventsOf(...evs: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const ev of evs) yield ev;
}

interface Recorded {
  io: AgentTurnIO;
  system: string[];
  tokens: string[];
  wrote: ExtractedActor[];
  aborted: { value: boolean };
}

function recordingIO(): Recorded {
  const system: string[] = [];
  const tokens: string[] = [];
  const wrote: ExtractedActor[] = [];
  const aborted = { value: false };
  return {
    io: {
      onSystem: (text) => system.push(text),
      onToken: (token) => tokens.push(token),
      writeActor: (actor) => wrote.push(actor),
      abort: () => {
        aborted.value = true;
      },
    },
    system,
    tokens,
    wrote,
    aborted,
  };
}

const COUNTER_CODE =
  "from cowboy import actor\n\n@actor\nclass Counter:\n    def get(self, payload):\n        return b\"0\"\n";

test("happy path: text streams, write_actor writes a file, done returns final text", async () => {
  const r = recordingIO();
  const result = await runAgentTurn(
    eventsOf(
      { type: "stream_start", seq: 0, ts: 1, protocol: 1, conversationId: "c", sessionId: "s", model: "cowboy-actor" },
      { type: "text_delta", seq: 1, ts: 2, iteration: 0, delta: "Sure — " },
      { type: "tool_use_start", seq: 2, ts: 3, iteration: 0, toolUseId: "t1", toolName: "write_actor", displayName: "Write actor" },
      { type: "tool_output_delta", seq: 3, ts: 4, iteration: 0, toolUseId: "t1", channel: "draft", delta: "class Counter" },
      { type: "tool_output_delta", seq: 4, ts: 5, iteration: 0, toolUseId: "t1", channel: "repair", delta: "IGNORED" },
      { type: "tool_result", seq: 5, ts: 6, iteration: 0, toolUseId: "t1", status: "ok", durationMs: 10, output: { status: "ok", language: "python", code: COUNTER_CODE, warnings: [], notes: "" } },
      { type: "done", seq: 6, ts: 7, totalIterations: 1, finalAssistantContent: "Done. Want me to: Test it / Deploy it / Tweak it" }
    ),
    r.io
  );

  assert.equal(r.system[0], "AI builder (cowboy-actor)");
  assert.equal(r.system[1], "⚙ Write actor…");
  assert.deepEqual(r.tokens, ["Sure — ", "class Counter"]);
  assert.equal(r.wrote.length, 1);
  assert.equal(r.wrote[0].filePath, "actors/counter/main.py");
  assert.match(r.system[2], /Wrote Counter to actors\/counter\/main\.py/);
  assert.equal(result.finalText, "Done. Want me to: Test it / Deploy it / Tweak it");
  assert.equal(result.wrote.length, 1);
  assert.equal(result.error, null);
});

test("pending signature: explains, aborts, returns without error", async () => {
  const r = recordingIO();
  const result = await runAgentTurn(
    eventsOf(
      { type: "tool_use_start", seq: 0, ts: 1, iteration: 0, toolUseId: "t1", toolName: "deploy_actor", displayName: "Deploy actor" },
      { type: "tool_pending_signature", seq: 1, ts: 2, iteration: 0, toolUseId: "t1", preview: { kind: "deploy", summary: "deploy Counter", payload: {} } },
      // Never reached — the turn returns at the signature event:
      { type: "text_delta", seq: 2, ts: 3, iteration: 0, delta: "UNREACHED" }
    ),
    r.io
  );
  assert.equal(r.aborted.value, true);
  assert.match(r.system.join("\n"), /wallet signature/);
  assert.match(r.system.join("\n"), /\/actor deploy/);
  assert.ok(!r.tokens.includes("UNREACHED"));
  assert.equal(result.error, null);
});

test("unrecoverable error: aborts and returns the message", async () => {
  const r = recordingIO();
  const result = await runAgentTurn(
    eventsOf({ type: "error", seq: 0, ts: 1, message: "runner unavailable", recoverable: false }),
    r.io
  );
  assert.equal(r.aborted.value, true);
  assert.equal(result.error, "runner unavailable");
});

test("recoverable error: surfaces a warning and keeps going", async () => {
  const r = recordingIO();
  const result = await runAgentTurn(
    eventsOf(
      { type: "error", seq: 0, ts: 1, message: "tool hiccup", recoverable: true },
      { type: "done", seq: 1, ts: 2, totalIterations: 1, finalAssistantContent: "recovered" }
    ),
    r.io
  );
  assert.match(r.system.join("\n"), /tool hiccup/);
  assert.equal(result.error, null);
  assert.equal(result.finalText, "recovered");
});

test("failed write_actor surfaces notes instead of writing", async () => {
  const r = recordingIO();
  await runAgentTurn(
    eventsOf(
      { type: "tool_use_start", seq: 0, ts: 1, iteration: 0, toolUseId: "t1", toolName: "write_actor" },
      { type: "tool_result", seq: 1, ts: 2, iteration: 0, toolUseId: "t1", status: "error", durationMs: 5, output: { status: "error", language: "python", code: "", warnings: [], notes: "runner unavailable" } }
    ),
    r.io
  );
  assert.equal(r.wrote.length, 0);
  assert.match(r.system.join("\n"), /write_actor.*runner unavailable/);
});

test("other tool results render their summary", async () => {
  const r = recordingIO();
  await runAgentTurn(
    eventsOf(
      { type: "tool_use_start", seq: 0, ts: 1, iteration: 0, toolUseId: "t1", toolName: "simulate_actor", displayName: "Simulate" },
      { type: "tool_result", seq: 1, ts: 2, iteration: 0, toolUseId: "t1", status: "ok", durationMs: 5, output: {}, summary: "simulation passed" }
    ),
    r.io
  );
  assert.match(r.system.join("\n"), /✓ simulation passed/);
});
```

- [ ] **Step 5.2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module './agent-turn.js'`.

- [ ] **Step 5.3: Create `src/agent-turn.ts`**

```ts
/**
 * runAgentTurn — consume one agent chat turn (stream of AgentEvents) and
 * translate it into UI actions via injected callbacks. Pure mapping: no
 * fetch, no fs, no React, so it is unit-testable with synthetic streams.
 *
 * Event semantics mirror the dashboard frontend's ChatView handling; see
 * docs/superpowers/specs/2026-06-10-lasso-agent-backend-design.md.
 */

import type { AgentEvent } from "./agent-client.js";
import { actorFromCode } from "./actor-extractor.js";
import type { ExtractedActor } from "./actor-extractor.js";

export interface AgentTurnIO {
  /** Render a system status line (tool activity, notices). */
  onSystem: (text: string) => void;
  /** Append streaming text (assistant prose and write_actor drafts). */
  onToken: (token: string) => void;
  /** Persist a generated actor to disk. */
  writeActor: (actor: ExtractedActor) => void;
  /** Abort the underlying HTTP stream. */
  abort: () => void;
}

export interface AgentTurnResult {
  /** Server-sanitized final answer; null when the stream ended early. */
  finalText: string | null;
  /** Actors written this turn, in order. */
  wrote: ExtractedActor[];
  /** Fatal error message, or null. */
  error: string | null;
}

interface WriteActorOutput {
  status?: string;
  code?: string;
  notes?: string;
}

export async function runAgentTurn(
  events: AsyncIterable<AgentEvent>,
  io: AgentTurnIO
): Promise<AgentTurnResult> {
  const wrote: ExtractedActor[] = [];
  const toolNames = new Map<string, string>();
  let finalText: string | null = null;

  for await (const ev of events) {
    switch (ev.type) {
      case "stream_start":
        io.onSystem(`AI builder (${ev.model})`);
        break;

      case "text_delta":
        io.onToken(ev.delta);
        break;

      case "tool_use_start":
        toolNames.set(ev.toolUseId, ev.toolName);
        io.onSystem(`⚙ ${ev.displayName ?? ev.toolName}…`);
        break;

      case "tool_output_delta":
        // Only the draft channel streams to the user; repair/log would
        // show stale intermediate code (the file is written from the
        // post-repair tool_result.output.code).
        if (ev.channel === "draft") io.onToken(ev.delta);
        break;

      case "tool_result": {
        const toolName = toolNames.get(ev.toolUseId);
        if (toolName === "write_actor") {
          const out = (ev.output ?? {}) as WriteActorOutput;
          if (
            ev.status === "ok" &&
            out.status === "ok" &&
            typeof out.code === "string" &&
            out.code.trim()
          ) {
            const actor = actorFromCode(out.code);
            io.writeActor(actor);
            wrote.push(actor);
            io.onSystem(`Wrote ${actor.className ?? "actor"} to ${actor.filePath}`);
          } else {
            io.onSystem(`✗ write_actor: ${out.notes || ev.summary || "failed"}`);
          }
        } else if (ev.summary) {
          io.onSystem(`${ev.status === "ok" ? "✓" : "✗"} ${ev.summary}`);
        }
        break;
      }

      case "tool_pending_signature":
        io.onSystem(
          "This action needs a wallet signature — lasso can't sign agent transactions yet. " +
            "Use /actor deploy <file> instead."
        );
        io.abort();
        return { finalText, wrote, error: null };

      case "error":
        if (!ev.recoverable) {
          io.abort();
          return { finalText, wrote, error: ev.message };
        }
        io.onSystem(`⚠ ${ev.message}`);
        break;

      case "done":
        finalText = ev.finalAssistantContent;
        break;

      // reasoning_delta, iteration_start/end, tool_use_input_delta,
      // tool_use_end: intentionally not rendered in the TUI.
      default:
        break;
    }
  }

  return { finalText, wrote, error: null };
}
```

- [ ] **Step 5.4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -20`
Expected: PASS — 6 new tests green (55 total).

- [ ] **Step 5.5: Commit**

```bash
git add src/agent-turn.ts src/agent-turn.test.ts
git commit -m "feat: runAgentTurn maps agent events to TUI actions"
```

---

### Task 6: Wire the agent path into `src/app.tsx`

**Files:**
- Modify: `src/app.tsx` (imports ~line 35; refs near line 436; `handlePromptSubmit` at line 990; `handleInterrupt` at line 1174)

No new unit test — this is Ink glue over the tested modules; behavior is covered by Tasks 1–5 plus the manual smoke in Task 7. Verify with `make check` (typecheck catches wiring mistakes).

- [ ] **Step 6.1: Add imports and refs**

After the `streamChat` import (line 35–36 area), add:

```ts
import { createConversation, streamAgentChat } from "./agent-client.js";
import { runAgentTurn } from "./agent-turn.js";
```

Near the other state hooks (after `const [isExecuting, setIsExecuting] = useState(false);`, line 440), add:

```ts
  // Agent-mode session state: one conversation per lasso session, created
  // lazily on the first AI prompt. abort ref lets Ctrl+C cancel a stream.
  const conversationIdRef = useRef<string | null>(null);
  const agentAbortRef = useRef<(() => void) | null>(null);
```

- [ ] **Step 6.2: Add the agent branch at the top of `handlePromptSubmit`**

`handlePromptSubmit` (line 990) currently starts with the `!session.runnerUrl` guard. Replace that opening so the body reads:

```ts
  const handlePromptSubmit = useCallback(
    async (prompt: string) => {
      if (session.dashboardUrl) {
        await runAgentPrompt(prompt);
        return;
      }

      if (!session.runnerUrl) {
        addMessage(
          "error",
          "No AI endpoint configured. Set dashboard_url (or runner_url for direct mode) in .cowboy/config.json, or run /init."
        );
        return;
      }

      // ... existing direct-vLLM body, unchanged from here down ...
```

(The rest of the existing function — `setIsExecuting(true)` through the `finally` block — stays exactly as it is. Add `runAgentPrompt` to the dependency array: `[session, addMessage, runAgentPrompt]`.)

- [ ] **Step 6.3: Add `runAgentPrompt` above `handlePromptSubmit`**

```ts
  const runAgentPrompt = useCallback(
    async (prompt: string) => {
      const dashboardUrl = session.dashboardUrl;
      if (!dashboardUrl) return;

      if (!session.walletAddress) {
        addMessage("error", "AI builder needs a wallet. Run /init to set one up.");
        return;
      }

      setIsExecuting(true);
      setStreamingText("");
      let streamed = "";

      try {
        if (!conversationIdRef.current) {
          conversationIdRef.current = await createConversation(
            dashboardUrl,
            session.walletAddress,
            prompt
          );
        }

        // Inline any local .py files the user referenced, like the direct
        // path does — the backend can't read this machine's files. The
        // backend's own knowledge tool replaces the local knowledge pack.
        const content = prompt + collectLocalFileContext(prompt);

        const handle = streamAgentChat(dashboardUrl, {
          conversationId: conversationIdRef.current,
          content,
        });
        agentAbortRef.current = handle.abort;

        const result = await runAgentTurn(handle.events, {
          onSystem: (text) => addMessage("system", text),
          onToken: (token) => {
            streamed += token;
            setStreamingText((prev) => prev + token);
          },
          writeActor: (actor) => {
            const fullPath = join(process.cwd(), actor.filePath);
            mkdirSync(dirname(fullPath), { recursive: true });
            writeFileSync(fullPath, actor.code + "\n", "utf-8");
          },
          abort: handle.abort,
        });

        if (result.error) {
          addMessage("error", `AI builder failed: ${result.error}`);
        }
        const finalText = result.finalText ?? streamed;
        if (finalText.trim()) {
          addMessage("output", finalText);
        }
        if (result.wrote.length > 0) {
          addMessage("system", `Deploy with: /actor deploy ${result.wrote[0].filePath}`);
        }
      } catch (err) {
        const aborted = err instanceof Error && err.name === "AbortError";
        if (!aborted) {
          // Keep whatever streamed before the disconnect, then explain.
          if (streamed.trim()) {
            addMessage("output", streamed);
          }
          addMessage(
            "error",
            `AI builder failed: ${err instanceof Error ? err.message : String(err)} — check dashboard_url in .cowboy/config.json (currently ${dashboardUrl})`
          );
        }
      } finally {
        agentAbortRef.current = null;
        setIsExecuting(false);
        setStreamingText("");
      }
    },
    [session, addMessage]
  );
```

- [ ] **Step 6.4: Let Ctrl+C abort an in-flight agent stream**

In `handleInterrupt` (line 1174), replace the first line:

```ts
    if (isExecuting) return;
```

with:

```ts
    if (isExecuting) {
      if (agentAbortRef.current) {
        agentAbortRef.current();
        addMessage("system", "Interrupted.");
      }
      return;
    }
```

- [ ] **Step 6.5: Typecheck and full test run**

Run: `make check 2>&1 | tail -10`
Expected: typecheck clean, 55 tests pass.

- [ ] **Step 6.6: Commit**

```bash
git add src/app.tsx
git commit -m "feat: AI builder streams the dashboard agent loop when dashboard_url is set"
```

---

### Task 7: Docs, version, manual smoke against mesa

**Files:**
- Modify: `CHANGELOG.md`, `README.md`, `package.json`
- Modify: `docs/superpowers/specs/2026-06-10-lasso-agent-backend-design.md`

- [ ] **Step 7.1: CHANGELOG + version bump**

Add at the top of `CHANGELOG.md` (above `## [0.3.5]`):

```markdown
## [0.4.0] - 2026-06-10

### Changed
- The AI actor builder now drives the dashboard backend agent
  (`POST /api/agent/chat` on `dashboard.mesa.cowboylabs.net` by default) —
  the same agent loop, tools, and conversations as the dashboard frontend.
  Generated actors are still written to `actors/<name>/main.py` with a
  `/actor deploy` hint.
- `dashboard_url` now defaults to `https://dashboard.mesa.cowboylabs.net`.
  Set `"dashboard_url": ""` in `.cowboy/config.json` to opt out and use the
  direct `runner_url` vLLM path instead.
- Ctrl+C now cancels an in-flight AI stream.

### Known gaps
- Agent actions that need a wallet signature (deploy/transfer) are not yet
  supported from lasso; the builder points you at `/actor deploy` instead.
```

In `package.json`, change `"version"` to `"0.4.0"`.

- [ ] **Step 7.2: README**

In the README's AI builder / configuration section, document the new behavior (adjust to the surrounding prose style):

```markdown
### AI builder backends

Plain-text prompts go to the Cowboy dashboard agent at
`https://dashboard.mesa.cowboylabs.net` (configurable via `dashboard_url`
in `.cowboy/config.json`). The agent generates actor code server-side;
lasso writes it to `actors/<name>/main.py` and suggests `/actor deploy`.

To use a direct vLLM runner instead (the pre-0.4 behavior), set
`"dashboard_url": ""` and point `runner_url` at your runner.
```

- [ ] **Step 7.3: Sync the spec with two implementation details**

In `docs/superpowers/specs/2026-06-10-lasso-agent-backend-design.md`:
- In **Architecture & data flow** item 1, replace "Removing `dashboard_url` from `.cowboy/config.json` opts back into direct mode." with: "Setting `"dashboard_url": ""` in `.cowboy/config.json` opts back into direct mode (absent means the mesa default)."
- In item 3, after the request body sentence, add: "`content` is the prompt plus `collectLocalFileContext(prompt)` — lasso still inlines local `.py` files the user references, since the backend cannot read them."
- In **Testing**, replace "Routing rule: dashboard set / runner only / neither." with: "Routing rule: `dashboard_url` resolution unit-tested in `config.test.ts`; the branch itself is Ink glue, exercised by manual smoke (steps 1 and 4)."

- [ ] **Step 7.4: Full check**

Run: `make check 2>&1 | tail -10`
Expected: clean.

- [ ] **Step 7.5: Manual smoke against live mesa**

```bash
mkdir -p /tmp/lasso-smoke && cd /tmp/lasso-smoke
mkdir -p .cowboy
cat > .cowboy/config.json <<'EOF'
{
  "rpc_url": "https://rpc.mesa.cowboylabs.net",
  "wallet_address": "<YOUR MESA WALLET ADDRESS>"
}
EOF
cd /Users/l/cowboy/lasso/.claude/worktrees/agent-backend && npm run dev
```

(With a real terminal; `npm run dev` must run with cwd `/tmp/lasso-smoke` — easiest is `cd /tmp/lasso-smoke && node --import tsx /Users/l/cowboy/lasso/.claude/worktrees/agent-backend/src/cli.tsx`.)

Verify, in order:
1. Type `build me a counter actor` → see `AI builder (<model>)`, streaming text, `⚙ Write actor…`, `Wrote Counter to actors/counter/main.py`, deploy hint. Confirm `/tmp/lasso-smoke/actors/counter/main.py` exists and contains the dispatch shim.
2. Second prompt `add a reset method` → same conversation continues (no duplicate `AI builder` conversation; server remembers the counter context).
3. Ctrl+C mid-stream → `Interrupted.`, prompt usable again.
4. Edit config: `"dashboard_url": ""`, no `runner_url` → prompt shows the "No AI endpoint configured" error.
5. Check the conversation also appears in the dashboard UI at https://dashboard.mesa.cowboylabs.net (same wallet) — proof of functional equivalence.

- [ ] **Step 7.6: Commit**

```bash
git add CHANGELOG.md README.md package.json docs/superpowers/specs/2026-06-10-lasso-agent-backend-design.md
git commit -m "docs: 0.4.0 — AI builder via dashboard agent; config + smoke notes"
```

---

## Post-plan

After all tasks: use superpowers:verification-before-completion, then superpowers:finishing-a-development-branch (PR against `main`; note the unrelated WIP sitting uncommitted in the main checkout — do not absorb it).
