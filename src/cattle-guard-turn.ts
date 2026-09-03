import { actorFromCode, type ExtractedActor } from "./actor-extractor.js";
import type { CattleGuardEvent } from "./cattle-guard-client.js";

export type PendingRequestOutcome = "continue" | "stop" | { error: string };

export interface CattleGuardTurnIO {
  onSystem: (text: string) => void;
  onToken: (token: string) => void;
  writeActor: (actor: ExtractedActor) => Promise<boolean>;
  onQuestion: (
    event: Extract<CattleGuardEvent, { type: "tool_pending_question" }>
  ) => Promise<PendingRequestOutcome>;
  onSignature: (
    event: Extract<CattleGuardEvent, { type: "tool_pending_signature" }>
  ) => Promise<PendingRequestOutcome>;
  onApproval: (
    event: Extract<CattleGuardEvent, { type: "tool_pending_approval" }>
  ) => Promise<PendingRequestOutcome>;
  onClientTool: (
    event: Extract<CattleGuardEvent, { type: "tool_pending_client_tool" }>
  ) => Promise<PendingRequestOutcome>;
  /** The runner refused the attached workspace delegation. The caller drops
   *  any cached bundle so the next turn fetches a fresh one. */
  onWorkspaceRefused?: () => void;
}

export const WORKSPACE_REFUSED_CODE = "workspace_delegation_refused";

export interface CattleGuardTurnResult {
  finalText: string | null;
  wrote: ExtractedActor[];
  error: string | null;
}

interface WriteActorOutput {
  status?: string;
  code?: string;
  notes?: string;
}

function pendingError(outcome: PendingRequestOutcome): string | null {
  return typeof outcome === "object" ? outcome.error : null;
}

export async function runCattleGuardTurn(
  events: AsyncIterable<CattleGuardEvent>,
  io: CattleGuardTurnIO
): Promise<CattleGuardTurnResult> {
  const wrote: ExtractedActor[] = [];
  const toolNames = new Map<string, string>();
  let finalText: string | null = null;
  let sawTerminal = false;
  let startShown = false;

  for await (const event of events) {
    switch (event.type) {
      case "stream_start":
        if (!startShown) {
          startShown = true;
          io.onSystem(`AI agent (${event.model})`);
        }
        break;
      case "text_delta":
        io.onToken(event.delta);
        break;
      case "plan": {
        const marker = (status: string) =>
          status === "completed" ? "[x]" : status === "in_progress" ? "[~]" : "[ ]";
        io.onSystem(["Plan:", ...event.steps.map((step) => `  ${marker(step.status)} ${step.text}`)].join("\n"));
        break;
      }
      case "tool_use_start":
        toolNames.set(event.toolUseId, event.toolName);
        if (event.toolName !== "update_plan") {
          io.onSystem(`${event.displayName ?? event.toolName} started`);
        }
        break;
      case "tool_output_delta":
        if (event.channel === "draft") io.onToken(event.delta);
        break;
      case "tool_result": {
        const toolName = toolNames.get(event.toolUseId);
        if (toolName === "update_plan") break;
        if (toolName === "write_actor") {
          const output = (event.output ?? {}) as WriteActorOutput;
          if (
            event.status === "ok" &&
            output.status === "ok" &&
            typeof output.code === "string" &&
            output.code.trim()
          ) {
            const actor = actorFromCode(output.code);
            if (await io.writeActor(actor)) {
              wrote.push(actor);
              io.onSystem(`Wrote ${actor.className ?? "actor"} to ${actor.filePath}`);
            } else {
              io.onSystem(`Write skipped: ${actor.filePath}`);
            }
          } else {
            io.onSystem(`write_actor failed: ${output.notes || event.summary || "unknown error"}`);
          }
        } else if (event.summary) {
          io.onSystem(`${event.status}: ${event.summary}`);
        }
        break;
      }
      case "tool_pending_question": {
        io.onSystem(`Question: ${event.question}`);
        const outcome = await io.onQuestion(event);
        const error = pendingError(outcome);
        if (error) return { finalText, wrote, error };
        if (outcome === "stop") return { finalText, wrote, error: null };
        break;
      }
      case "tool_pending_signature": {
        io.onSystem("Transaction signature requested");
        const outcome = await io.onSignature(event);
        const error = pendingError(outcome);
        if (error) return { finalText, wrote, error };
        if (outcome === "stop") return { finalText, wrote, error: null };
        break;
      }
      case "tool_pending_approval": {
        io.onSystem(`Command approval requested: ${event.summary}`);
        const outcome = await io.onApproval(event);
        const error = pendingError(outcome);
        if (error) return { finalText, wrote, error };
        if (outcome === "stop") return { finalText, wrote, error: null };
        break;
      }
      case "tool_pending_client_tool": {
        io.onSystem(`${event.toolName} requested`);
        const outcome = await io.onClientTool(event);
        const error = pendingError(outcome);
        if (error) return { finalText, wrote, error };
        if (outcome === "stop") return { finalText, wrote, error: null };
        break;
      }
      case "secret_request":
        io.onSystem(
          `Needs secret ${event.name}${event.reason ? ` (${event.reason})` : ""}; configure it in Dashboard.`
        );
        break;
      case "error":
        if (event.code === WORKSPACE_REFUSED_CODE) io.onWorkspaceRefused?.();
        if (!event.recoverable) return { finalText, wrote, error: event.message };
        io.onSystem(`Warning: ${event.message}`);
        break;
      case "done":
        finalText = event.finalAssistantContent;
        break;
      case "run_status":
        if (event.status === "failed") {
          sawTerminal = true;
          return { finalText, wrote, error: event.reason || "Cattle Guard run failed" };
        }
        if (event.status === "interrupted") {
          sawTerminal = true;
          return { finalText, wrote, error: null };
        }
        if (event.status === "completed") {
          sawTerminal = true;
          return { finalText, wrote, error: null };
        }
        break;
      default:
        break;
    }
  }

  return {
    finalText,
    wrote,
    error: sawTerminal ? null : "Cattle Guard stream ended before a terminal run status",
  };
}
