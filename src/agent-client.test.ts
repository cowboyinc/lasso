import test from "node:test";
import assert from "node:assert/strict";
import { parseEventStream, createConversation, streamAgentChat } from "./agent-client.js";
import type { AgentEvent } from "./agent-client.js";

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of parseEventStream(body)) events.push(ev);
  return events;
}

test("parseEventStream parses data frames separated by blank lines", async () => {
  const events = await collect(
    streamFromChunks([
      'data: {"type":"stream_start","seq":0,"ts":1,"protocol":1,"conversationId":"c1","sessionId":"s1","model":"cowboy-actor"}\n\n',
      'data: {"type":"text_delta","seq":1,"ts":2,"iteration":0,"delta":"howdy"}\n\n',
      'data: {"type":"done","seq":2,"ts":3,"totalIterations":1,"finalAssistantContent":"howdy"}\n\n',
    ])
  );
  assert.equal(events.length, 3);
  assert.equal(events[0].type, "stream_start");
  assert.equal(events[1].type, "text_delta");
  assert.equal((events[2] as { finalAssistantContent: string }).finalAssistantContent, "howdy");
});

test("parseEventStream handles frames split across chunk boundaries", async () => {
  const frame = 'data: {"type":"text_delta","seq":0,"ts":1,"iteration":0,"delta":"split"}\n\n';
  const events = await collect(
    streamFromChunks([frame.slice(0, 25), frame.slice(25, 40), frame.slice(40)])
  );
  assert.equal(events.length, 1);
  assert.equal((events[0] as { delta: string }).delta, "split");
});

test("parseEventStream skips non-data frames, malformed JSON, and CRLF noise", async () => {
  const events = await collect(
    streamFromChunks([
      ": keepalive comment\n\n",
      "data: {not json}\n\n",
      'data: {"type":"text_delta","seq":0,"ts":1,"iteration":0,"delta":"ok"}\r\n\n',
    ])
  );
  assert.equal(events.length, 1);
  assert.equal((events[0] as { delta: string }).delta, "ok");
});

test("parseEventStream handles event:+data: two-line frames (actual server format)", async () => {
  const events = await collect(
    streamFromChunks([
      'event: text_delta\ndata: {"type":"text_delta","seq":0,"ts":1,"iteration":0,"delta":"real"}\n\n',
    ])
  );
  assert.equal(events.length, 1);
  assert.equal((events[0] as { delta: string }).delta, "real");
});

test("parseEventStream flushes a final frame missing its trailing separator", async () => {
  const events = await collect(
    streamFromChunks([
      'data: {"type":"done","seq":0,"ts":1,"totalIterations":1,"finalAssistantContent":"bye"}',
    ])
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "done");
});

test("createConversation posts wallet/kind/firstMessage and returns the id", async () => {
  const realFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody: unknown = null;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ conversation: { id: "conv-42" } }), {
      status: 200,
    });
  }) as typeof fetch;

  try {
    const id = await createConversation(
      "https://dashboard.mesa.cowboylabs.net/",
      "0xabc",
      "build a counter"
    );
    assert.equal(id, "conv-42");
    assert.equal(
      capturedUrl,
      "https://dashboard.mesa.cowboylabs.net/api/conversations"
    );
    assert.deepEqual(capturedBody, {
      wallet: "0xabc",
      kind: "builder",
      firstMessage: "build a counter",
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("createConversation throws a descriptive error on non-200", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("wallet and kind required", { status: 400 })) as typeof fetch;
  try {
    await assert.rejects(
      () => createConversation("https://x.test", "0xabc", "hi"),
      /create conversation 400: wallet and kind required/
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("streamAgentChat posts conversationId/content and yields parsed events", async () => {
  const realFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody: unknown = null;
  const sse =
    'data: {"type":"text_delta","seq":0,"ts":1,"iteration":0,"delta":"yee"}\n\n' +
    'data: {"type":"done","seq":1,"ts":2,"totalIterations":1,"finalAssistantContent":"yee"}\n\n';
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(String(init?.body));
    return new Response(sse, { status: 200 });
  }) as typeof fetch;

  try {
    const handle = streamAgentChat("https://x.test", {
      conversationId: "conv-42",
      content: "build a counter",
    });
    const events: string[] = [];
    for await (const ev of handle.events) events.push(ev.type);
    assert.deepEqual(events, ["text_delta", "done"]);
    assert.equal(capturedUrl, "https://x.test/api/agent/chat");
    assert.deepEqual(capturedBody, {
      conversationId: "conv-42",
      content: "build a counter",
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("streamAgentChat throws a descriptive error on non-200", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("conversation not found", { status: 404 })) as typeof fetch;
  try {
    const handle = streamAgentChat("https://x.test", {
      conversationId: "nope",
      content: "hi",
    });
    await assert.rejects(async () => {
      for await (const ev of handle.events) void ev;
    }, /agent chat 404: conversation not found/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("parseEventStream aborts when a frame never terminates (buffer cap)", async () => {
  const chunk = "x".repeat(1024 * 1024);
  await assert.rejects(
    () => collect(streamFromChunks(Array.from({ length: 11 }, () => chunk))),
    /no frame separator within 10MB/
  );
});
