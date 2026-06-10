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
