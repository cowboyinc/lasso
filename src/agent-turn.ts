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
  /** Persist a generated actor to disk. Sync by contract; if it throws
   *  (fs error), the exception propagates out of runAgentTurn to the
   *  caller's catch. */
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

  for await (const ev of events) {
    switch (ev.type) {
      case "stream_start":
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

      case "clarify": {
        // doc 63 — the agent asked a question and is ending the turn. The
        // question + options arrive as the turn's final text; cue the user to
        // reply (lasso can't render clickable buttons, so a numbered hint).
        flushReasoning();
        if (ev.options && ev.options.length > 0) {
          const opts = ev.options.map((o, i) => `  ${i + 1}. ${o}`);
          io.onSystem(["Reply to continue (pick one or type your own):", ...opts].join("\n"));
        } else {
          io.onSystem("The agent needs your input — reply to continue.");
        }
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
