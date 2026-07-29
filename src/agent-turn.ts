/**
 * runAgentTurn — consume one agent chat turn (stream of AgentEvents) and
 * translate it into UI actions via injected callbacks. Pure mapping: no
 * fetch, no fs, no React, so it is unit-testable with synthetic streams.
 *
 * Event semantics mirror the dashboard frontend's ChatView handling; see
 * docs/superpowers/specs/2026-06-10-lasso-agent-backend-design.md.
 */

import type { AgentEvent } from "./agent-client.js";
import type { ClientToolRequest } from "./client-tool-bridge.js";
import { actorFromCode } from "./actor-extractor.js";
import type { ExtractedActor } from "./actor-extractor.js";

/** A `tool_pending_signature` the backend is blocking on, reduced to what the
 *  local signer needs. */
export interface PendingSignatureRequest {
  /** From `stream_start`; the broker key the callback must echo. */
  sessionId: string;
  toolUseId: string;
  /** The 32-byte tx hash to sign (`preview.payload.hashHex`). */
  hashHex: string;
  /** Human summary for the approval line. */
  summary: string;
}

/** Outcome of resolving a pending signature. `"signed"` lets the turn continue
 *  (the backend resumes the loop); anything else stops it. */
export type PendingSignatureResult =
  | "signed"
  | "cancelled"
  | { error: string };

/** Outcome of a client_tool_request dispatch (COW-2455). `"continue"` = the tool
 *  result was posted and the backend resumes the loop; `"stop"` = the user
 *  cancelled/denied; `{error}` = the dispatch or the result POST failed. */
export type ClientToolTurnOutcome = "continue" | "stop" | { error: string };

export interface AgentTurnIO {
  /** Render a system status line (tool activity, notices). */
  onSystem: (text: string) => void;
  /** Append streaming text (assistant prose and write_actor drafts). */
  onToken: (token: string) => void;
  /** Persist a generated actor to disk. Sync by contract; if it throws
   *  (fs error), the exception propagates out of runAgentTurn to the
   *  caller's catch. */
  writeActor: (actor: ExtractedActor) => void;
  /** Abort the underlying HTTP stream. */
  abort: () => void;
  /** The agent called `ask_user` and is BLOCKING (PR #177). Collect the user's
   *  answer and POST it to /api/agent/answer-callback, then resolve — the run
   *  resumes and the SAME stream continues. When absent, the turn can't be
   *  answered (the run stays parked); the CLI wires this to its input prompt. */
  onAskUser?: (event: {
    sessionId: string;
    toolUseId: string;
    question: string;
    choices?: string[];
  }) => Promise<void>;
  /** Resolve a pending signature: sign `hashHex` locally + POST the
   *  sign-callback. Injected so runAgentTurn stays pure (no fetch / no CLI).
   *  Absent → the legacy "can't sign, use /actor deploy" fallback. */
  resolvePendingSignature?: (
    req: PendingSignatureRequest
  ) => Promise<PendingSignatureResult>;
  /** Dispatch a generic client_tool_request (COW-2455): run the named local tool
   *  and POST its result to resume the loop. Injected so runAgentTurn stays pure
   *  (no registry / fetch here). Absent → the request is surfaced as an
   *  unsupported-tool notice and the turn continues. */
  dispatchClientTool?: (
    req: ClientToolRequest,
    sessionId: string
  ) => Promise<ClientToolTurnOutcome>;
}

/** Pull the 32-byte signing hash out of a `tool_pending_signature` payload.
 *  Returns null when it's missing/malformed. */
export function hashHexFromPayload(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "hashHex" in payload) {
    const h = (payload as { hashHex: unknown }).hashHex;
    if (typeof h === "string" && h.length > 0) return h;
  }
  return null;
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

  // Agent mode emits the model's chain-of-thought as reasoning_delta. We
  // buffer it and flush a single condensed "thinking" line per step (before
  // the next tool call / answer) so the user sees the agent reasoning without
  // the TUI being flooded by token-by-token thought.
  let reasoningBuf = "";
  const flushReasoning = () => {
    const condensed = reasoningBuf.replace(/\s+/g, " ").trim();
    reasoningBuf = "";
    if (!condensed) return;
    const preview = condensed.length > 240 ? condensed.slice(0, 240) + "…" : condensed;
    io.onSystem(`thinking: ${preview}`);
  };

  // The route and the AgentLoop each emit a stream_start on the loop path;
  // only announce the model once.
  let startShown = false;
  // Captured from stream_start; needed to key the sign-callback (COW-2465).
  let sessionId: string | null = null;

  for await (const ev of events) {
    switch (ev.type) {
      case "stream_start":
        // Both stream_start events carry the same sessionId; keep the first.
        if (sessionId === null) sessionId = ev.sessionId;
        if (!startShown) {
          startShown = true;
          io.onSystem(`AI agent (${ev.model})`);
        }
        break;

      case "reasoning_delta":
        reasoningBuf += ev.delta;
        break;

      case "plan": {
        // Live checklist (doc 61 T1.4). Render the whole list each update;
        // [x] done, [~] in progress, [ ] pending.
        flushReasoning();
        const mark = (s: string) =>
          s === "completed" ? "[x]" : s === "in_progress" ? "[~]" : "[ ]";
        const lines = ev.steps.map((s) => `  ${mark(s.status)} ${s.text}`);
        io.onSystem(["Plan:", ...lines].join("\n"));
        break;
      }

      case "tool_pending_question": {
        // ask_user (PR #177): the run is BLOCKED awaiting the user's answer.
        // Prompt + POST the answer via onAskUser; the same stream resumes.
        flushReasoning();
        const choiceLines = (ev.choices && ev.choices.length > 0)
          ? ["", ...ev.choices.map((c, i) => `  ${i + 1}. ${c}`), "", "(type a number or your own answer)"]
          : [];
        io.onSystem([`Question: ${ev.question}`, ...choiceLines].join("\n"));
        if (io.onAskUser) {
          await io.onAskUser({
            sessionId: ev.sessionId,
            toolUseId: ev.toolUseId,
            question: ev.question,
            choices: ev.choices,
          });
        } else {
          io.onSystem("(this client can't collect the answer — the run is waiting)");
        }
        break;
      }

      case "secret_request": {
        // doc 63 §9 — agent needs a secret; the value is set in the dashboard's
        // secure Secrets UI, never in chat.
        flushReasoning();
        io.onSystem(
          `Needs secret ${ev.name}${ev.reason ? ` (${ev.reason})` : ""} — set its value in the dashboard Secrets menu; it never passes through here.`
        );
        break;
      }

      case "text_delta":
        flushReasoning();
        io.onToken(ev.delta);
        break;

      case "tool_use_start":
        flushReasoning();
        toolNames.set(ev.toolUseId, ev.toolName);
        // update_plan renders as the "Plan:" checklist via its plan event;
        // don't also print a "⚙ Update plan…" activity line.
        if (ev.toolName !== "update_plan") {
          io.onSystem(`⚙ ${ev.displayName ?? ev.toolName}…`);
        }
        break;

      case "tool_output_delta":
        // Only the draft channel streams to the user; repair/log would
        // show stale intermediate code (the file is written from the
        // post-repair tool_result.output.code).
        if (ev.channel === "draft") io.onToken(ev.delta);
        break;

      case "tool_result": {
        const toolName = toolNames.get(ev.toolUseId);
        if (toolName === "update_plan") {
          // Rendered via the plan event; swallow the tool result line.
          break;
        }
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
            // The "Deploy with: /actor deploy <path>" hint is emitted once
            // per turn by the caller (app.tsx) from result.wrote — not here.
            io.onSystem(`Wrote ${actor.className ?? "actor"} to ${actor.filePath}`);
          } else {
            io.onSystem(`✗ write_actor: ${out.notes || ev.summary || "failed"}`);
          }
        } else if (ev.summary) {
          io.onSystem(`${ev.status === "ok" ? "✓" : "✗"} ${ev.summary}`);
        }
        break;
      }

      case "tool_pending_signature": {
        const hashHex = hashHexFromPayload(ev.preview.payload);
        // Bridge path (COW-2465): sign locally + resume the loop. Only when a
        // resolver is injected, we captured the sessionId, and the payload
        // carries the hash.
        if (io.resolvePendingSignature && sessionId && hashHex) {
          io.onSystem(`⚙ signing: ${ev.preview.summary}…`);
          let outcome: PendingSignatureResult;
          try {
            outcome = await io.resolvePendingSignature({
              sessionId,
              toolUseId: ev.toolUseId,
              hashHex,
              summary: ev.preview.summary,
            });
          } catch (err) {
            outcome = { error: err instanceof Error ? err.message : String(err) };
          }
          if (outcome === "signed") {
            io.onSystem(`✓ signed: ${ev.preview.summary}`);
            // Do NOT abort — the backend resumes the loop and streams on.
            break;
          }
          if (outcome === "cancelled") {
            io.onSystem("✗ signature cancelled");
            io.abort();
            return { finalText, wrote, error: null };
          }
          io.onSystem(`✗ signing failed: ${outcome.error}`);
          io.abort();
          return { finalText, wrote, error: outcome.error };
        }
        // Legacy fallback: no local signing wired.
        io.onSystem(
          "This action needs a wallet signature — configure signing or use " +
            "/actor deploy <file> instead."
        );
        io.abort();
        return { finalText, wrote, error: null };
      }

      case "client_tool_request": {
        // Generic bridge (COW-2455). Dispatch the named local tool and post its
        // result; the backend resumes the loop on success. Same shape as the
        // signing case above — signing keeps its dedicated path (dual-path)
        // until the backend generalizes.
        if (!io.dispatchClientTool || !sessionId) {
          io.onSystem(`⚠ unsupported local tool: ${ev.toolName}`);
          break;
        }
        io.onSystem(`⚙ ${ev.summary ?? ev.toolName}…`);
        let outcome: ClientToolTurnOutcome;
        try {
          outcome = await io.dispatchClientTool(
            {
              toolUseId: ev.toolUseId,
              toolName: ev.toolName,
              args: ev.args,
              summary: ev.summary,
            },
            sessionId
          );
        } catch (err) {
          outcome = { error: err instanceof Error ? err.message : String(err) };
        }
        if (outcome === "continue") break; // backend resumes; keep consuming
        if (outcome === "stop") {
          io.onSystem(`✗ ${ev.toolName} cancelled`);
          io.abort();
          return { finalText, wrote, error: null };
        }
        io.onSystem(`✗ ${ev.toolName} failed: ${outcome.error}`);
        io.abort();
        return { finalText, wrote, error: outcome.error };
      }

      case "error":
        if (!ev.recoverable) {
          io.abort();
          return { finalText, wrote, error: ev.message };
        }
        io.onSystem(`⚠ ${ev.message}`);
        break;

      case "done":
        // Terminal event — stop consuming so trailing/stale events can't
        // mutate committed UI state. The server closes the stream after
        // done anyway; this makes it a guarantee.
        flushReasoning();
        finalText = ev.finalAssistantContent;
        return { finalText, wrote, error: null };

      // iteration_start/end, tool_use_input_delta, tool_use_end:
      // intentionally not rendered in the TUI.
      default:
        break;
    }
  }

  return { finalText, wrote, error: null };
}
