import test from "node:test";
import assert from "node:assert/strict";
import { parseEventStream } from "./agent-client.js";
import type {
  AgentEvent,
  ToolPendingSignatureEvent,
  ClientToolRequestEvent,
} from "./agent-client.js";
import {
  requestFromPendingSignature,
  requestFromClientToolEvent,
  SIGN_TOOL_NAME,
} from "./client-tool-bridge.js";

const HASH = "0x" + "ab".repeat(32);

/**
 * Mirror-drift guard. Event types are hand-copied from the dashboard backend
 * (no shared-types package — COW-2473). These frozen wire payloads pin the
 * exact JSON shape the client decodes; if the backend renames a field, the
 * adapter assertions below fail loudly instead of silently mis-mapping.
 */
const PENDING_SIGNATURE_FRAME = JSON.stringify({
  type: "tool_pending_signature",
  seq: 5,
  ts: 1,
  iteration: 0,
  toolUseId: "sig1",
  preview: {
    kind: "deploy",
    summary: "Deploy Counter",
    payload: { hashHex: HASH, nonce: 0 },
  },
});

const CLIENT_TOOL_FRAME = JSON.stringify({
  type: "client_tool_request",
  seq: 6,
  ts: 2,
  iteration: 0,
  toolUseId: "ct1",
  toolName: "local_read_file",
  args: { path: "a.py" },
  summary: "read a.py",
});

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const body = frames.map((f) => `data: ${f}\n\n`).join("");
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(body));
      c.close();
    },
  });
}

async function parseAll(frames: string[]): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of parseEventStream(sseStream(frames))) out.push(ev);
  return out;
}

test("fixture: SSE frames parse into the typed events", async () => {
  const evs = await parseAll([PENDING_SIGNATURE_FRAME, CLIENT_TOOL_FRAME]);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].type, "tool_pending_signature");
  assert.equal(evs[1].type, "client_tool_request");
});

test("fixture: pending-signature frame normalizes to the signHash request", async () => {
  const [ev] = await parseAll([PENDING_SIGNATURE_FRAME]);
  const req = requestFromPendingSignature(ev as ToolPendingSignatureEvent);
  assert.deepEqual(req, {
    toolUseId: "sig1",
    toolName: SIGN_TOOL_NAME,
    args: { hashHex: HASH },
    summary: "Deploy Counter",
  });
});

test("fixture: client_tool_request frame normalizes to a generic request", async () => {
  const [ev] = await parseAll([CLIENT_TOOL_FRAME]);
  const e = ev as ClientToolRequestEvent;
  const req = requestFromClientToolEvent({
    toolUseId: e.toolUseId,
    toolName: e.toolName,
    args: e.args,
    summary: e.summary,
  });
  assert.deepEqual(req, {
    toolUseId: "ct1",
    toolName: "local_read_file",
    args: { path: "a.py" },
    summary: "read a.py",
  });
});
