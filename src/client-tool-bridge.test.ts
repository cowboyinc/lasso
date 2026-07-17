import test from "node:test";
import assert from "node:assert/strict";
import {
  ToolRegistry,
  makeSignTool,
  requestFromClientToolEvent,
  requestFromPendingSignature,
  SIGN_TOOL_NAME,
  type ClientToolResult,
  type LocalTool,
} from "./client-tool-bridge.js";
import type { ToolPendingSignatureEvent } from "./agent-client.js";
import type { EcdsaSignature } from "./signer.js";

const FAKE_SIG: EcdsaSignature = { r: "0x1", s: "0x2", v: 27 };
const VALID_HASH = "0x" + "ab".repeat(32); // 64 hex chars

function okTool(name: string, output: unknown): LocalTool {
  return { name, validate: () => {}, run: async () => ({ status: "ok", output }) };
}

test("dispatch: registered tool round-trips its result", async () => {
  const reg = new ToolRegistry();
  reg.register(okTool("echo", { hi: true }));
  const res = await reg.dispatch({ toolUseId: "t1", toolName: "echo", args: {} });
  assert.deepEqual(res, { status: "ok", output: { hi: true } });
});

test("dispatch: unknown tool → structured error, never throws", async () => {
  const reg = new ToolRegistry();
  const res = await reg.dispatch({ toolUseId: "t1", toolName: "nope", args: {} });
  assert.equal(res.status, "error");
  if (res.status === "error") assert.equal(res.errorCode, "unknown_tool");
});

test("dispatch: invalid args → invalid_args error (validate runs before run)", async () => {
  const reg = new ToolRegistry();
  let ran = false;
  reg.register({
    name: "strict",
    validate: () => {
      throw new Error("bad args");
    },
    run: async () => {
      ran = true;
      return { status: "ok", output: null };
    },
  });
  const res = await reg.dispatch({ toolUseId: "t1", toolName: "strict", args: {} });
  assert.equal(res.status, "error");
  if (res.status === "error") assert.equal(res.errorCode, "invalid_args");
  assert.equal(ran, false, "run must not fire when validate throws");
});

test("dispatch: a throwing tool → tool_failed error", async () => {
  const reg = new ToolRegistry();
  reg.register({
    name: "boom",
    validate: () => {},
    run: async () => {
      throw new Error("kaboom");
    },
  });
  const res = await reg.dispatch({ toolUseId: "t1", toolName: "boom", args: {} });
  assert.equal(res.status, "error");
  if (res.status === "error") assert.equal(res.errorCode, "tool_failed");
});

test("dispatch: a tool may return a distinct cancelled result (not collapsed to error)", async () => {
  const reg = new ToolRegistry();
  const cancelled: ClientToolResult = { status: "cancelled", reason: "user_cancelled" };
  reg.register({ name: "gated", validate: () => {}, run: async () => cancelled });
  const res = await reg.dispatch({ toolUseId: "t1", toolName: "gated", args: {} });
  assert.deepEqual(res, cancelled);
});

test("register: rejects a duplicate name", () => {
  const reg = new ToolRegistry();
  reg.register(okTool("dup", 1));
  assert.throws(() => reg.register(okTool("dup", 2)), /already registered/);
});

test("supportedNames: sorted advertisement for the handshake", () => {
  const reg = new ToolRegistry();
  reg.register(okTool("b", 1));
  reg.register(okTool("a", 1));
  assert.deepEqual(reg.supportedNames(), ["a", "b"]);
});

test("sign tool: valid hash signs and returns the signature as output", async () => {
  const reg = new ToolRegistry();
  reg.register(makeSignTool(async () => FAKE_SIG));
  const res = await reg.dispatch({
    toolUseId: "t1",
    toolName: SIGN_TOOL_NAME,
    args: { hashHex: VALID_HASH },
  });
  assert.deepEqual(res, { status: "ok", output: FAKE_SIG });
});

test("sign tool: rejects a malformed hash before signing (args are untrusted)", async () => {
  const reg = new ToolRegistry();
  let signed = false;
  reg.register(
    makeSignTool(async () => {
      signed = true;
      return FAKE_SIG;
    })
  );
  for (const bad of ["", "0x123", "deadbeef", VALID_HASH + "ff"]) {
    const res = await reg.dispatch({
      toolUseId: "t1",
      toolName: SIGN_TOOL_NAME,
      args: { hashHex: bad },
    });
    assert.equal(res.status, "error");
    if (res.status === "error") assert.equal(res.errorCode, "invalid_args");
  }
  assert.equal(signed, false, "must never call the signer on a bad hash");
});

test("adapter: legacy pending-signature maps onto the signHash tool", () => {
  const ev = {
    type: "tool_pending_signature",
    seq: 1,
    ts: 0,
    iteration: 0,
    toolUseId: "tu1",
    preview: { kind: "deploy", summary: "Deploy Counter", payload: { hashHex: VALID_HASH } },
  } as ToolPendingSignatureEvent;
  const req = requestFromPendingSignature(ev);
  assert.ok(req);
  assert.equal(req?.toolName, SIGN_TOOL_NAME);
  assert.deepEqual(req?.args, { hashHex: VALID_HASH });
  assert.equal(req?.toolUseId, "tu1");
  assert.equal(req?.summary, "Deploy Counter");
});

test("adapter: pending-signature with no hash → null (caller uses legacy notice)", () => {
  const ev = {
    type: "tool_pending_signature",
    seq: 1,
    ts: 0,
    iteration: 0,
    toolUseId: "tu1",
    preview: { kind: "deploy", summary: "x", payload: {} },
  } as ToolPendingSignatureEvent;
  assert.equal(requestFromPendingSignature(ev), null);
});

test("adapter: generic client_tool_request passes fields through", () => {
  const req = requestFromClientToolEvent({
    toolUseId: "tu2",
    toolName: "local_read_file",
    args: { path: "a.py" },
    summary: "read a.py",
  });
  assert.deepEqual(req, {
    toolUseId: "tu2",
    toolName: "local_read_file",
    args: { path: "a.py" },
    summary: "read a.py",
  });
});
