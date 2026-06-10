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
