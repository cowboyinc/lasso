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
