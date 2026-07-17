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
  | ToolPendingQuestionEvent
  | RunStatusEvent
  | ClientToolRequestEvent
  | PlanEvent
  | SecretRequestEvent
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

/** Chain-of-thought tokens from a reasoning runner. NOT part of the answer —
 *  shown as a transient "Thinking…" affordance, never persisted. */
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

/** Generic client-tool request (COW-2455): the backend asks the client to run a
 *  named local tool and awaits the result over the same stream. Generalizes
 *  ToolPendingSignatureEvent. Provisional wire shape (backend owner traveling);
 *  decoded ONLY via requestFromClientToolEvent in client-tool-bridge.ts, and
 *  INERT until the backend emits it. */
export interface ClientToolRequestEvent extends BaseEvent {
  type: "client_tool_request";
  iteration: number;
  toolUseId: string;
  toolName: string;
  args: unknown;
  /** Human summary for the approval UI (COW-2463). */
  summary?: string;
}

/** A single step in the agent's live plan/todo checklist (doc 61 T1.4). */
export interface PlanStep {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

/** The agent's current plan. The full ordered list is sent each time; replace
 *  the rendered checklist with `steps`. */
export interface PlanEvent extends BaseEvent {
  type: "plan";
  iteration: number;
  steps: PlanStep[];
}

/** The agent called `ask_user` and is BLOCKING until answered (dashboard PR
 *  #177). The run parks in awaiting_input; the client collects the answer and
 *  POSTs it to /api/agent/answer-callback (correlated by sessionId+toolUseId),
 *  which resumes the same run — the SSE stays open and streams the rest. */
export interface ToolPendingQuestionEvent extends BaseEvent {
  type: "tool_pending_question";
  sessionId: string;
  toolUseId: string;
  question: string;
  /** <=4 short choices; the client also allows free-text ("Other"). */
  choices?: string[];
}

/** Detached-run state transition (running / awaiting_input / terminal). */
export interface RunStatusEvent extends BaseEvent {
  type: "run_status";
  runId: string;
  status: "running" | "awaiting_input" | "completed" | "interrupted" | "failed";
}

/** POST an ask_user answer (or cancel) to resume a blocked run. */
export async function postAnswerCallback(
  dashboardUrl: string,
  body: { sessionId: string; toolUseId: string; action: "answer" | "cancel"; answer?: string }
): Promise<void> {
  const base = dashboardUrl.replace(/\/$/, "");
  const resp = await fetch(`${base}/api/agent/answer-callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`answer-callback ${resp.status}: ${text.slice(0, 200)}`);
  }
}

/** The agent needs a secret the user must set via the secure UI (doc 63 §9). */
export interface SecretRequestEvent extends BaseEvent {
  type: "secret_request";
  iteration: number;
  name: string;
  reason: string;
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

/** Hard cap on un-framed SSE bytes. A healthy stream emits a \n\n separator
 *  every few KB; without a cap, a misbehaving endpoint that never sends a
 *  separator would grow the buffer unboundedly. */
const MAX_SSE_BUFFER_BYTES = 10 * 1024 * 1024;

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

      if (buffer.length > MAX_SSE_BUFFER_BYTES) {
        throw new Error(
          "agent stream: no frame separator within 10MB — aborting"
        );
      }

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

  // Intentional divergence from the upstream browser client: flush any
  // unterminated final frame. The server always ends frames with \n\n, but
  // lasso reads over a real remote connection where truncation can eat the
  // final separator — without this, a truncated `done` event vanishes.
  buffer += decoder.decode();
  if (buffer.trim()) {
    const event = parseFrame(buffer);
    if (event) yield event;
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

export interface AgentChatRequest {
  conversationId: string;
  content: string;
  /** When true, restrict the agent to read-only research. Unused by lasso today. */
  planMode?: boolean;
  /** Optional model id. Omitted: the server resolves its default. */
  model?: string;
  /** Conversation mode (doc 61). "agent" = run-until-done (the model builds,
   *  tests, and self-corrects across iterations before reporting). "guided" =
   *  the legacy build-then-stop wizard. Omitted: server default (guided). */
  mode?: "guided" | "agent";
  /** Local tool names this client can execute (COW-2456 capability handshake).
   *  The backend only emits `client_tool_request` for advertised tools; a
   *  backend that doesn't consume this yet simply ignores it. */
  clientTools?: string[];
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
  // No timeout on purpose: this is a fast non-streaming POST, and the TUI's
  // Ctrl+C abort only arms once the chat stream starts.
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
    if (init.signal.aborted) {
      controller.abort();
    } else {
      init.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
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

/** Resolve (or cancel) a `tool_pending_signature` on the backend. Mirrors the
 *  web frontend's TxPreviewModal.postSignCallback: the client signs
 *  `preview.payload.hashHex` locally and posts `{r,s,v}` here; the backend's
 *  signature broker rebuilds and submits the tx it prepared. This is the
 *  client-tool bridge (COW-2455) specialized to signing (COW-2465). */
export async function postSignCallback(
  dashboardUrl: string,
  body: {
    sessionId: string;
    toolUseId: string;
    action: "sign" | "cancel";
    signature?: { r: string; s: string; v: number };
  }
): Promise<void> {
  const base = dashboardUrl.replace(/\/$/, "");
  const resp = await fetch(`${base}/api/agent/sign-callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`sign-callback ${resp.status}: ${text.slice(0, 200)}`);
  }
}

/** Resume a `client_tool_request` by posting the local tool's result — the
 *  generic sibling of postSignCallback (COW-2455). Hits the assumed
 *  `/api/agent/tool-result` endpoint; INERT until the backend implements it, so
 *  signing keeps flowing over postSignCallback (dual-path) meanwhile. */
export async function postToolResult(
  dashboardUrl: string,
  body: {
    sessionId: string;
    toolUseId: string;
    status: "ok" | "error" | "cancelled";
    output?: unknown;
    /** Present only when status is "cancelled". */
    reason?: string;
  }
): Promise<void> {
  const base = dashboardUrl.replace(/\/$/, "");
  const resp = await fetch(`${base}/api/agent/tool-result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`tool-result ${resp.status}: ${text.slice(0, 200)}`);
  }
}
