import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CattleGuardClient,
  clientIdentityHeaders,
  loadOrCreateClientInstanceId,
  readCattleGuardSseFrames,
  validateCattleGuardBaseUrl,
} from "./cattle-guard-client.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const WALLET = "0xabcd000000000000000000000000000000000001";
const TOKEN = "aaa.bbb.ccc";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function session() {
  return {
    runId: RUN_ID,
    status: "queued",
    lastCommittedOrd: 1,
    streamUrl: `/api/agent/runs/${RUN_ID}/events?fromOrd=0`,
    accessToken: TOKEN,
    accessTokenExpiresAt: "2099-01-01T00:00:00Z",
  };
}

test("Cattle Guard base URL rejects credentials, paths, and remote HTTP", () => {
  assert.equal(
    validateCattleGuardBaseUrl("https://cattle-guard.canyon.cowboylabs.net").origin,
    "https://cattle-guard.canyon.cowboylabs.net"
  );
  assert.equal(validateCattleGuardBaseUrl("http://localhost:8787").origin, "http://localhost:8787");
  assert.throws(() => validateCattleGuardBaseUrl("http://example.com"));
  assert.throws(() => validateCattleGuardBaseUrl("https://user@example.com"));
  assert.throws(() => validateCattleGuardBaseUrl("https://example.com/api"));
});

test("client instance id is stable and stored with private permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "lasso-client-id-"));
  try {
    const first = loadOrCreateClientInstanceId(dir);
    const second = loadOrCreateClientInstanceId(dir);
    assert.equal(second, first);
    assert.equal(JSON.parse(readFileSync(join(dir, "client.json"), "utf8")).clientInstanceId, first);
    if (process.platform !== "win32") {
      assert.equal(statSync(join(dir, "client.json")).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SSE parser handles CRLF, event names, ids, and split chunks", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("event: done\r\nid: 4\r\nda"));
      controller.enqueue(encoder.encode("ta: {\"type\":\"done\"}\r\n\r\n"));
      controller.close();
    },
  });
  const frames = [];
  for await (const frame of readCattleGuardSseFrames(stream)) frames.push(frame);
  assert.deepEqual(frames, [
    { event: "done", id: "4", data: '{"type":"done"}' },
  ]);
});

test("direct admission sends wallet proof and streams through terminal run status", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const encoder = new TextEncoder();
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/api/agent/protocol")) {
      return json({
        major: 1,
        minor: 4,
        minClientMinor: 1,
        schemaDigest: "digest",
        serverBuild: "test",
        capabilities: ["resume_by_ord"],
        limits: {},
      });
    }
    if (url.endsWith("/api/agent/client-runs")) return json(session(), 202);
    if (url.includes(`/api/agent/runs/${RUN_ID}/events`)) {
      const events = [
        {
          type: "done",
          seq: 1,
          ts: 1,
          ord: 0,
          runId: RUN_ID,
          totalIterations: 1,
          finalAssistantContent: "finished",
          reason: "end_turn",
        },
        {
          type: "run_status",
          seq: 2,
          ts: 2,
          ord: 1,
          runId: RUN_ID,
          status: "completed",
        },
      ];
      const body = events
        .map((event) => `event: ${event.type}\nid: ${event.ord}\ndata: ${JSON.stringify(event)}\n\n`)
        .join("");
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(body));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    }
    throw new Error(`unexpected request ${url}`);
  };
  const client = new CattleGuardClient({
    baseUrl: "https://cattle-guard.canyon.cowboylabs.net",
    walletAddress: WALLET,
    clientInstanceId: CLIENT_ID,
    fetchFn,
    now: () => 42 * 3_600_000,
    signHash: async () => ({
      r: `0x${"11".repeat(32)}`,
      s: `0x${"22".repeat(32)}`,
      v: 1,
    }),
  });
  const run = await client.startRun({
    conversationId: CONVERSATION_ID,
    query: "build an actor",
    clientTools: ["local_list", "local_read", "local_write"],
  });
  const types: string[] = [];
  for await (const event of run.events()) types.push(event.type);
  assert.deepEqual(types, ["done", "run_status"]);

  const admission = calls.find((call) => call.url.endsWith("/api/agent/client-runs"));
  assert.ok(admission);
  const headers = admission.init?.headers as Record<string, string>;
  assert.match(headers["x-cowboy-agent-sig"], /^0x[0-9a-f]{130}$/);
  assert.equal(headers["x-cowboy-agent-ts"], "42");
  assert.equal(admission.init?.redirect, "error");
  const body = JSON.parse(String(admission.init?.body));
  assert.deepEqual(body.turn.clientTools, ["local_list", "local_read", "local_write"]);
  assert.equal(body.turn.modelRole, "agentic");
  assert.equal("workspaceDelegation" in body.turn, false);
  assert.equal(body.clientInfo.capabilities.resumeByOrd, true);
  assert.equal(body.clientInfo.capabilities.commandApprovals, true);

  // Every request names the client: protocol, admission, and the stream.
  assert.equal(calls.length, 3);
  for (const call of calls) {
    const sent = call.init?.headers as Record<string, string>;
    assert.equal(sent["cowboy-client"], "lasso");
    assert.match(sent["cowboy-client-version"], /^[\x21-\x7e]{1,32}$/);
    assert.match(sent["cowboy-client-platform"], /^[a-z0-9]+-[a-z0-9]+$/);
  }
});

test("a workspace delegation rides on the turn untouched", async () => {
  let admissionBody: Record<string, unknown> | null = null;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/agent/protocol")) {
      return json({
        major: 1,
        minor: 4,
        minClientMinor: 1,
        schemaDigest: "digest",
        serverBuild: "test",
        capabilities: [],
        limits: {},
      });
    }
    if (url.endsWith("/api/agent/client-runs")) {
      admissionBody = JSON.parse(String(init?.body));
      return json(session(), 202);
    }
    throw new Error(`unexpected request ${url}`);
  };
  const client = new CattleGuardClient({
    baseUrl: "https://cattle-guard.canyon.cowboylabs.net",
    walletAddress: WALLET,
    clientInstanceId: CLIENT_ID,
    fetchFn,
    signHash: async () => ({ r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}`, v: 1 }),
  });
  const workspaceDelegation = {
    cbfs_key_enc_b64: "a2V5",
    delegation_json: "{\"wallet_address\":\"0xabcd\"}",
    ras_delegation_json: "{}",
  };
  await client.startRun({ conversationId: CONVERSATION_ID, query: "go", clientTools: [], workspaceDelegation });
  const turn = (admissionBody as Record<string, unknown> | null)?.turn as Record<string, unknown>;
  assert.deepEqual(turn.workspaceDelegation, workspaceDelegation);
});

test("client identity headers are bounded printable tokens", () => {
  const headers = clientIdentityHeaders("0.4.3", "darwin-arm64");
  assert.deepEqual(headers, {
    "cowboy-client": "lasso",
    "cowboy-client-version": "0.4.3",
    "cowboy-client-platform": "darwin-arm64",
  });
  const odd = clientIdentityHeaders("1.0.0, beta", "Windows 11");
  assert.equal(odd["cowboy-client-version"], "1.0.0beta");
  assert.equal(odd["cowboy-client-platform"], "Windows11");
  assert.equal(clientIdentityHeaders(" ", "\u00e9")["cowboy-client-version"], undefined);
  assert.equal(clientIdentityHeaders("x".repeat(40), "p")["cowboy-client-version"], "x".repeat(32));
});

test("protected request ids are validated before a bearer request is sent", async () => {
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/api/agent/protocol")) {
      return json({
        major: 1,
        minor: 4,
        minClientMinor: 1,
        schemaDigest: "digest",
        serverBuild: "test",
        capabilities: [],
        limits: {},
      });
    }
    if (url.endsWith("/api/agent/client-runs")) return json(session(), 202);
    throw new Error(`unexpected request ${url}`);
  };
  const client = new CattleGuardClient({
    baseUrl: "https://cattle-guard.canyon.cowboylabs.net",
    walletAddress: WALLET,
    clientInstanceId: CLIENT_ID,
    fetchFn,
    signHash: async () => ({
      r: `0x${"11".repeat(32)}`,
      s: `0x${"22".repeat(32)}`,
      v: 1,
    }),
  });
  const run = await client.startRun({
    conversationId: CONVERSATION_ID,
    query: "test",
    clientTools: [],
  });
  const before = calls.length;
  await assert.rejects(run.protectedRequest("../../protocol"), /invalid Cattle Guard request id/);
  assert.equal(calls.length, before);
});
