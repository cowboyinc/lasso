import test from "node:test";
import assert from "node:assert/strict";
import { runCattleGuardTurn } from "./cattle-guard-turn.js";
import type { CattleGuardEvent } from "./cattle-guard-client.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

type BareEvent = CattleGuardEvent extends infer Event
  ? Event extends unknown
    ? Omit<Event, "seq" | "ts" | "ord" | "runId">
    : never
  : never;

async function* events(values: BareEvent[]) {
  let ord = 0;
  for (const value of values) {
    yield { ...value, seq: ord, ts: ord, ord: ord++, runId: RUN_ID } as CattleGuardEvent;
  }
}

function io() {
  const system: string[] = [];
  const tokens: string[] = [];
  return {
    system,
    tokens,
    value: {
      onSystem: (value: string) => system.push(value),
      onToken: (value: string) => tokens.push(value),
      writeActor: async () => true,
      onQuestion: async () => "continue" as const,
      onSignature: async () => "continue" as const,
      onApproval: async () => "continue" as const,
      onClientTool: async () => "continue" as const,
    },
  };
}

test("done content is retained while consumption continues to terminal run status", async () => {
  const recorder = io();
  const result = await runCattleGuardTurn(
    events([
      {
        type: "done",
        totalIterations: 1,
        finalAssistantContent: "answer",
        reason: "end_turn",
      },
      { type: "run_status", status: "completed" },
    ]),
    recorder.value
  );
  assert.equal(result.finalText, "answer");
  assert.equal(result.error, null);
});

test("a stream without terminal run status is rejected", async () => {
  const recorder = io();
  const result = await runCattleGuardTurn(
    events([
      {
        type: "done",
        totalIterations: 1,
        finalAssistantContent: "answer",
        reason: "end_turn",
      },
    ]),
    recorder.value
  );
  assert.match(result.error ?? "", /terminal run status/);
});

test("a workspace refusal drops the cached bundle and still surfaces as a warning", async () => {
  const recorder = io();
  let refused = 0;
  const result = await runCattleGuardTurn(
    events([
      {
        type: "error",
        message: "This turn ran without your workspace: the runner refused the stored CBFS delegation.",
        recoverable: true,
        code: "workspace_delegation_refused",
      },
      { type: "error", message: "unrelated", recoverable: true, code: "other" },
      {
        type: "done",
        totalIterations: 1,
        finalAssistantContent: "answer",
        reason: "end_turn",
      },
      { type: "run_status", status: "completed" },
    ]),
    { ...recorder.value, onWorkspaceRefused: () => void (refused += 1) }
  );
  assert.equal(refused, 1);
  assert.equal(result.error, null);
  assert.equal(recorder.system.filter((line) => line.startsWith("Warning:")).length, 2);
});
