import test from "node:test";
import assert from "node:assert/strict";
import { DashboardConversationsClient } from "./dashboard-conversations.js";

const WALLET = "0xabcd000000000000000000000000000000000001";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "11111111-1111-4111-8111-111111111111";

test("Dashboard conversation creation and native-run registration are wallet proven", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/api/conversations")) {
      return Response.json({ conversation: { id: CONVERSATION_ID } });
    }
    if (url.endsWith(`/api/conversations/${CONVERSATION_ID}/cattle-guard-runs`)) {
      return Response.json({ runId: RUN_ID, status: "running" }, { status: 202 });
    }
    throw new Error(`unexpected request ${url}`);
  };
  const client = new DashboardConversationsClient({
    dashboardUrl: "https://dashboard.canyon.cowboylabs.net",
    walletAddress: WALLET,
    fetchFn,
    now: () => 42 * 3_600_000,
    signHash: async () => ({
      r: `0x${"11".repeat(32)}`,
      s: `0x${"22".repeat(32)}`,
      v: 1,
    }),
  });
  assert.equal(await client.createConversation("build it"), CONVERSATION_ID);
  await client.registerRun(CONVERSATION_ID, RUN_ID, "build it");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const headers = call.init?.headers as Record<string, string>;
    assert.match(headers["x-cowboy-conversations-sig"], /^0x[0-9a-f]{130}$/);
    assert.equal(headers["x-cowboy-conversations-ts"], "42");
    assert.equal(call.init?.redirect, "error");
  }
});
