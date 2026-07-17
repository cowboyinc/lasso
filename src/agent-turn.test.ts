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

  assert.equal(r.system[0], "AI agent (cowboy-actor)");
  assert.equal(r.system[1], "⚙ Write actor…");
  assert.deepEqual(r.tokens, ["Sure — ", "class Counter"]);
  assert.equal(r.wrote.length, 1);
  assert.equal(r.wrote[0].filePath, "actors/counter/main.py");
  assert.match(r.system[2], /Wrote Counter to actors\/counter\/main\.py/);
  assert.equal(result.finalText, "Done. Want me to: Test it / Deploy it / Tweak it");
  assert.equal(result.wrote.length, 1);
  assert.equal(result.error, null);
});

test("tool_pending_question renders the question + choices and calls onAskUser", async () => {
  const r = recordingIO();
  const calls: Array<{ toolUseId: string; question: string }> = [];
  await runAgentTurn(
    eventsOf(
      { type: "stream_start", seq: 0, ts: 1, protocol: 1, conversationId: "c", sessionId: "s", model: "m" },
      { type: "tool_pending_question", seq: 1, ts: 2, sessionId: "s", toolUseId: "t1", question: "What kind of actor?", choices: ["Counter", "Token"] },
      { type: "done", seq: 2, ts: 3, totalIterations: 1, finalAssistantContent: "ok" }
    ),
    { ...r.io, onAskUser: async (q) => { calls.push({ toolUseId: q.toolUseId, question: q.question }); } }
  );
  assert.equal(calls.length, 1, "onAskUser called once");
  assert.equal(calls[0].toolUseId, "t1");
  const line = r.system.find((s) => s.includes("Question: What kind of actor?"));
  assert.ok(line, "renders the question");
  assert.match(line!, /1\. Counter/);
  assert.match(line!, /2\. Token/);
});

test("plan event renders a checklist; update_plan tool start/result are suppressed", async () => {
  const r = recordingIO();
  await runAgentTurn(
    eventsOf(
      { type: "stream_start", seq: 0, ts: 1, protocol: 1, conversationId: "c", sessionId: "s", model: "m" },
      // update_plan tool activity should NOT print "⚙ Update plan…" or a result line.
      { type: "tool_use_start", seq: 1, ts: 2, iteration: 1, toolUseId: "p1", toolName: "update_plan", displayName: "Update plan" },
      { type: "plan", seq: 2, ts: 3, iteration: 1, steps: [
        { text: "Write the actor", status: "in_progress" },
        { text: "Simulate it", status: "pending" },
      ] },
      { type: "tool_result", seq: 3, ts: 4, iteration: 1, toolUseId: "p1", status: "ok", durationMs: 0, output: { status: "ok" }, summary: "plan updated (0/2 done)" },
      { type: "plan", seq: 4, ts: 5, iteration: 1, steps: [
        { text: "Write the actor", status: "completed" },
        { text: "Simulate it", status: "in_progress" },
      ] },
      { type: "done", seq: 5, ts: 6, totalIterations: 2, finalAssistantContent: "done" }
    ),
    r.io
  );

  // No tool activity line for update_plan.
  assert.ok(!r.system.some((s) => s.includes("Update plan")), "no ⚙ Update plan line");
  assert.ok(!r.system.some((s) => s.includes("plan updated")), "no tool_result summary line");
  // First plan checklist rendered with [~]/[ ].
  const first = r.system.find((s) => s.startsWith("Plan:") && s.includes("[~] Write the actor"));
  assert.ok(first, "first plan checklist rendered");
  assert.match(first!, /\[ \] Simulate it/);
  // Second plan checklist shows the first step completed.
  const second = r.system.find((s) => s.startsWith("Plan:") && s.includes("[x] Write the actor"));
  assert.ok(second, "updated plan checklist rendered");
  assert.match(second!, /\[~\] Simulate it/);
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

test("done ends the turn: trailing events are ignored", async () => {
  const r = recordingIO();
  const result = await runAgentTurn(
    eventsOf(
      { type: "text_delta", seq: 0, ts: 1, iteration: 0, delta: "answer" },
      { type: "done", seq: 1, ts: 2, totalIterations: 1, finalAssistantContent: "answer" },
      { type: "text_delta", seq: 2, ts: 3, iteration: 0, delta: "STALE" }
    ),
    r.io
  );
  assert.equal(result.finalText, "answer");
  assert.ok(!r.tokens.includes("STALE"));
});

import { hashHexFromPayload } from "./agent-turn.js";
import type {
  PendingSignatureRequest,
  PendingSignatureResult,
} from "./agent-turn.js";

function streamStart(): AgentEvent {
  return {
    type: "stream_start", seq: 0, ts: 1, protocol: 1,
    conversationId: "c", sessionId: "sess-1", model: "cowboy-actor",
  } as AgentEvent;
}

function pendingSig(hashHex: string | undefined): AgentEvent {
  return {
    type: "tool_pending_signature", seq: 1, ts: 2, iteration: 0, toolUseId: "sig1",
    preview: { kind: "deploy", summary: "Deploy Counter",
      payload: hashHex === undefined ? { nonce: 0 } : { hashHex, nonce: 0 } },
  } as AgentEvent;
}

test("signature bridge: signs, resumes the loop, reaches done", async () => {
  const r = recordingIO();
  const calls: PendingSignatureRequest[] = [];
  r.io.resolvePendingSignature = async (req): Promise<PendingSignatureResult> => {
    calls.push(req);
    return "signed";
  };
  const result = await runAgentTurn(
    eventsOf(
      streamStart(),
      pendingSig("0xdeadbeef"),
      { type: "done", seq: 2, ts: 3, totalIterations: 1, finalAssistantContent: "Deployed." } as AgentEvent
    ),
    r.io
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, "sess-1");
  assert.equal(calls[0].toolUseId, "sig1");
  assert.equal(calls[0].hashHex, "0xdeadbeef");
  assert.equal(r.aborted.value, false, "signed → loop must continue, not abort");
  assert.equal(result.finalText, "Deployed.");
  assert.equal(result.error, null);
});

test("signature bridge: cancelled aborts with no error", async () => {
  const r = recordingIO();
  r.io.resolvePendingSignature = async () => "cancelled";
  const result = await runAgentTurn(eventsOf(streamStart(), pendingSig("0x01")), r.io);
  assert.equal(r.aborted.value, true);
  assert.equal(result.error, null);
});

test("signature bridge: signer error aborts and surfaces the error", async () => {
  const r = recordingIO();
  r.io.resolvePendingSignature = async () => ({ error: "cowboy sign-hash failed" });
  const result = await runAgentTurn(eventsOf(streamStart(), pendingSig("0x01")), r.io);
  assert.equal(r.aborted.value, true);
  assert.equal(result.error, "cowboy sign-hash failed");
});

test("signature bridge: no resolver → legacy fallback + abort", async () => {
  const r = recordingIO(); // no resolvePendingSignature
  const result = await runAgentTurn(eventsOf(streamStart(), pendingSig("0x01")), r.io);
  assert.equal(r.aborted.value, true);
  assert.equal(result.error, null);
  assert.ok(r.system.some((s) => /wallet signature/i.test(s)), "shows fallback notice");
});

test("signature bridge: missing hashHex falls back (never signs a bad payload)", async () => {
  const r = recordingIO();
  let called = false;
  r.io.resolvePendingSignature = async () => { called = true; return "signed"; };
  await runAgentTurn(eventsOf(streamStart(), pendingSig(undefined)), r.io);
  assert.equal(called, false, "no hashHex → resolver must not be invoked");
  assert.equal(r.aborted.value, true);
});

test("hashHexFromPayload extracts / rejects", () => {
  assert.equal(hashHexFromPayload({ hashHex: "0xabc" }), "0xabc");
  assert.equal(hashHexFromPayload({ nonce: 1 }), null);
  assert.equal(hashHexFromPayload({ hashHex: 123 }), null);
  assert.equal(hashHexFromPayload(null), null);
  assert.equal(hashHexFromPayload("nope"), null);
});

import type { ClientToolRequest } from "./client-tool-bridge.js";
import type { ClientToolTurnOutcome } from "./agent-turn.js";

function clientToolReq(): AgentEvent {
  return {
    type: "client_tool_request", seq: 1, ts: 2, iteration: 0,
    toolUseId: "ct1", toolName: "local_read_file",
    args: { path: "a.py" }, summary: "read a.py",
  } as AgentEvent;
}

test("client tool: continue → result posted, loop resumes to done, no abort", async () => {
  const r = recordingIO();
  const calls: ClientToolRequest[] = [];
  r.io.dispatchClientTool = async (req): Promise<ClientToolTurnOutcome> => {
    calls.push(req);
    return "continue";
  };
  const result = await runAgentTurn(
    eventsOf(
      streamStart(),
      clientToolReq(),
      { type: "done", seq: 2, ts: 3, totalIterations: 1, finalAssistantContent: "read it" } as AgentEvent
    ),
    r.io
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, "local_read_file");
  assert.deepEqual(calls[0].args, { path: "a.py" });
  assert.equal(r.aborted.value, false, "continue → must not abort");
  assert.equal(result.finalText, "read it");
  assert.equal(result.error, null);
});

test("client tool: stop → aborts with no error", async () => {
  const r = recordingIO();
  r.io.dispatchClientTool = async () => "stop";
  const result = await runAgentTurn(eventsOf(streamStart(), clientToolReq()), r.io);
  assert.equal(r.aborted.value, true);
  assert.equal(result.error, null);
});

test("client tool: dispatch error → aborts and surfaces the error", async () => {
  const r = recordingIO();
  r.io.dispatchClientTool = async () => ({ error: "tool blew up" });
  const result = await runAgentTurn(eventsOf(streamStart(), clientToolReq()), r.io);
  assert.equal(r.aborted.value, true);
  assert.equal(result.error, "tool blew up");
});

test("client tool: no dispatcher → unsupported notice, turn continues (no abort)", async () => {
  const r = recordingIO(); // no dispatchClientTool
  const result = await runAgentTurn(
    eventsOf(
      streamStart(),
      clientToolReq(),
      { type: "done", seq: 2, ts: 3, totalIterations: 1, finalAssistantContent: "ok" } as AgentEvent
    ),
    r.io
  );
  assert.equal(r.aborted.value, false);
  assert.ok(r.system.some((s) => /unsupported local tool: local_read_file/.test(s)));
  assert.equal(result.finalText, "ok");
});
