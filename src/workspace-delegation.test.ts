import test from "node:test";
import assert from "node:assert/strict";
import {
  BUNDLE_STATEMENT_PREFIX,
  WorkspaceDelegationClient,
  WorkspaceDelegationError,
  ensureWorkspaceDelegation,
  expectedBundleStatement,
  statementHashHex,
  validateBundle,
} from "./workspace-delegation.js";

const WALLET = "0xabcd000000000000000000000000000000000001";
const OTHER = "0xabcd000000000000000000000000000000000002";
const DASHBOARD = "https://dashboard.canyon.cowboylabs.net";
const HOST = "dashboard.canyon.cowboylabs.net";
const NONCE = "nonce_0123456789abcdefghijklmnopqrstuvwxyz";
const CERT_HASH = `0x${"3a".repeat(32)}`;
const RAS_HASH = `0x${"4b".repeat(32)}`;

function bundleFor(wallet: string) {
  return {
    cbfs_key_enc_b64: Buffer.from("key").toString("base64"),
    delegation_json: JSON.stringify({ wallet_address: wallet, scope: "mount" }),
    ras_delegation_json: JSON.stringify({ wallet_address: wallet }),
  };
}

const signHash = async (hashHex: string) => ({
  r: `0x${"11".repeat(32)}`,
  s: `0x${hashHex.slice(2, 4).repeat(32)}`,
  v: 1,
});

interface Call {
  url: string;
  init?: RequestInit;
  body?: Record<string, unknown>;
}

/** A dashboard that mints one nonce per challenge and consumes it on use. */
function fakeDashboard(options: {
  active: () => boolean;
  host?: string;
  statement?: (nonce: string) => string;
}) {
  const calls: Call[] = [];
  const open = new Set<string>();
  let counter = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, init, body });
    if (url.endsWith("/cbfs-delegation/bundle/challenge")) {
      const nonce = `${NONCE}${counter++}`;
      open.add(nonce);
      const message =
        options.statement?.(nonce) ?? expectedBundleStatement(WALLET, nonce, options.host ?? HOST);
      return Response.json({ nonce, message });
    }
    if (url.endsWith("/cbfs-delegation/bundle")) {
      const nonce = String(body?.nonce ?? "");
      if (!open.delete(nonce)) {
        return Response.json({ error: "invalid or expired nonce" }, { status: 401 });
      }
      if (!/^0x[0-9a-f]{130}$/.test(String(body?.signature))) {
        return Response.json({ error: "signature does not match wallet" }, { status: 401 });
      }
      return options.active()
        ? Response.json(bundleFor(WALLET))
        : Response.json({ error: "No active file-storage delegation" }, { status: 404 });
    }
    if (url.endsWith("/cbfs-delegation/prepare")) {
      return Response.json({ certHash: CERT_HASH, rasHash: RAS_HASH, cert: "{cert}", ras: "{ras}" });
    }
    if (url.endsWith("/cbfs-delegation/complete")) {
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected request ${url}`);
  };
  return { calls, fetchFn, open };
}

test("validateBundle rejects a bundle for another wallet and malformed shapes", () => {
  assert.deepEqual(validateBundle(bundleFor(WALLET), WALLET.toUpperCase()), bundleFor(WALLET));
  assert.throws(() => validateBundle(bundleFor(OTHER), WALLET), /different wallet/);
  assert.throws(
    () => validateBundle({ ...bundleFor(WALLET), cbfs_key_enc_b64: "" }, WALLET),
    /malformed/
  );
  assert.throws(
    () => validateBundle({ ...bundleFor(WALLET), delegation_json: "{not json" }, WALLET),
    /unparsable/
  );
  assert.throws(() => validateBundle(null, WALLET), WorkspaceDelegationError);
});

test("the statement lasso signs is fixed in shape and hashed as keccak of its bytes", () => {
  assert.equal(
    expectedBundleStatement(WALLET.toUpperCase(), NONCE, "Dashboard.Canyon.Cowboylabs.Net"),
    `${BUNDLE_STATEMENT_PREFIX}:${WALLET}:${NONCE}:${HOST}`
  );
  assert.match(statementHashHex("x"), /^0x[0-9a-f]{64}$/);
  assert.notEqual(statementHashHex("x"), statementHashHex("y"));
});

test("bundle fetch: files-proof challenge, signed statement, nonce spent once", async () => {
  const dashboard = fakeDashboard({ active: () => true });
  const signed: string[] = [];
  const client = new WorkspaceDelegationClient({
    dashboardUrl: DASHBOARD,
    walletAddress: WALLET,
    fetchFn: dashboard.fetchFn,
    now: () => 42 * 3_600_000,
    signHash: async (hashHex) => {
      signed.push(hashHex);
      return signHash(hashHex);
    },
  });
  assert.deepEqual(await client.bundle(), bundleFor(WALLET));

  const [challenge, fetch] = dashboard.calls;
  assert.equal(
    challenge.url,
    `${DASHBOARD}/api/wallet/${WALLET}/cbfs-delegation/bundle/challenge`
  );
  const challengeHeaders = challenge.init?.headers as Record<string, string>;
  assert.match(challengeHeaders["x-cowboy-files-sig"], /^0x[0-9a-f]{130}$/);
  assert.equal(challengeHeaders["x-cowboy-files-ts"], "42");
  assert.equal(challengeHeaders["cowboy-client"], "lasso");
  assert.equal(challenge.init?.redirect, "error");

  assert.equal(fetch.url, `${DASHBOARD}/api/wallet/${WALLET}/cbfs-delegation/bundle`);
  const fetchHeaders = fetch.init?.headers as Record<string, string>;
  assert.equal(fetchHeaders["x-cowboy-files-sig"], undefined);
  assert.equal(fetch.body?.nonce, `${NONCE}0`);
  assert.match(String(fetch.body?.signature), /^0x[0-9a-f]{130}$/);

  // Exactly two signatures: the hourly files proof and the statement digest.
  assert.equal(signed.length, 2);
  assert.equal(signed[1], statementHashHex(expectedBundleStatement(WALLET, `${NONCE}0`, HOST)));
  assert.equal(dashboard.open.size, 0);
});

test("bundle fetch refuses to sign a statement that is not the expected one", async () => {
  const wrongStatements: Array<(nonce: string) => string> = [
    (nonce) => expectedBundleStatement(OTHER, nonce, HOST),
    (nonce) => expectedBundleStatement(WALLET, nonce, "evil.example"),
    () => expectedBundleStatement(WALLET, "some-other-nonce-value-1234", HOST),
    (nonce) => `cowboy-session-v1:${WALLET}:${nonce}:${HOST}`,
  ];
  for (const statement of wrongStatements) {
    const dashboard = fakeDashboard({ active: () => true, statement });
    const signed: string[] = [];
    const client = new WorkspaceDelegationClient({
      dashboardUrl: DASHBOARD,
      walletAddress: WALLET,
      fetchFn: dashboard.fetchFn,
      signHash: async (hashHex) => {
        signed.push(hashHex);
        return signHash(hashHex);
      },
    });
    await assert.rejects(client.bundle(), /does not recognize/);
    // Only the files proof was signed; the statement never reached the key.
    assert.equal(signed.length, 1);
    assert.equal(dashboard.calls.filter((call) => call.url.endsWith("/bundle")).length, 0);
  }
});

test("bundle fetch reads 404 as no delegation and a missing route as an error", async () => {
  const inactive = fakeDashboard({ active: () => false });
  const client = new WorkspaceDelegationClient({
    dashboardUrl: DASHBOARD,
    walletAddress: WALLET,
    fetchFn: inactive.fetchFn,
    signHash,
  });
  assert.equal(await client.bundle(), null);

  const legacy: typeof fetch = async () =>
    Response.json(
      {
        message: "Route POST:/api/wallet/x/cbfs-delegation/bundle/challenge not found",
        error: "Not Found",
        statusCode: 404,
      },
      { status: 404 }
    );
  const old = new WorkspaceDelegationClient({
    dashboardUrl: DASHBOARD,
    walletAddress: WALLET,
    fetchFn: legacy,
    signHash,
  });
  await assert.rejects(old.bundle(), /does not expose the delegation bundle hand-off/);
});

test("mint signs the two prepared hashes with the project key and completes", async () => {
  const dashboard = fakeDashboard({ active: () => true });
  const signed: string[] = [];
  const client = new WorkspaceDelegationClient({
    dashboardUrl: DASHBOARD,
    walletAddress: WALLET,
    fetchFn: dashboard.fetchFn,
    signHash: async (hashHex) => {
      signed.push(hashHex);
      return signHash(hashHex);
    },
  });
  await client.mint();
  // The files-scope proof, the cert hash, and the RAS hash: nothing else is signed.
  assert.equal(signed.length, 3);
  assert.equal(signed[1], CERT_HASH);
  assert.equal(signed[2], RAS_HASH);
  const complete = dashboard.calls.find((call) => call.url.endsWith("/complete"));
  assert.ok(complete);
  assert.equal(complete.init?.method, "POST");
  assert.equal(complete.body?.cert, "{cert}");
  assert.equal(complete.body?.ras, "{ras}");
  assert.match(String(complete.body?.certSig), /^0x[0-9a-f]{130}$/);
  assert.match(String(complete.body?.rasSig), /^0x[0-9a-f]{130}$/);
  assert.notEqual(complete.body?.certSig, complete.body?.rasSig);
});

test("mint refuses a prepare response whose hashes are not 32-byte digests", async () => {
  const fetchFn: typeof fetch = async (input) => {
    if (String(input).endsWith("/prepare")) {
      return Response.json({ certHash: "0x1234", rasHash: RAS_HASH, cert: "{}", ras: "{}" });
    }
    throw new Error("unexpected");
  };
  const client = new WorkspaceDelegationClient({
    dashboardUrl: DASHBOARD,
    walletAddress: WALLET,
    fetchFn,
    signHash,
  });
  await assert.rejects(client.mint(), /malformed delegation to sign/);
});

test("ensureWorkspaceDelegation: held bundle, then dashboard, then approved mint", async () => {
  let active = false;
  const dashboard = fakeDashboard({ active: () => active });
  const client = new WorkspaceDelegationClient({
    dashboardUrl: DASHBOARD,
    walletAddress: WALLET,
    fetchFn: dashboard.fetchFn,
    signHash,
  });
  const system: string[] = [];
  let approvals = 0;
  const path = (call: Call) => call.url.slice(call.url.lastIndexOf("/cbfs-delegation"));

  // Declined mint: nothing attached.
  const declined = await ensureWorkspaceDelegation({
    client,
    held: null,
    approveMint: async () => false,
    onSystem: (text) => system.push(text),
  });
  assert.equal(declined, null);
  assert.match(system[0], /declined/);

  // Approved mint: prepare, complete, fresh challenge, fetch.
  dashboard.calls.length = 0;
  const minted = await ensureWorkspaceDelegation({
    client,
    held: null,
    approveMint: async () => {
      approvals += 1;
      active = true;
      return true;
    },
    onSystem: (text) => system.push(text),
  });
  assert.deepEqual(minted, bundleFor(WALLET));
  assert.equal(approvals, 1);
  assert.deepEqual(dashboard.calls.map(path), [
    "/cbfs-delegation/bundle/challenge",
    "/cbfs-delegation/bundle",
    "/cbfs-delegation/prepare",
    "/cbfs-delegation/complete",
    "/cbfs-delegation/bundle/challenge",
    "/cbfs-delegation/bundle",
  ]);

  // Held in memory: no network at all, but still wallet-checked.
  dashboard.calls.length = 0;
  const held = await ensureWorkspaceDelegation({
    client,
    held: minted,
    approveMint: async () => {
      throw new Error("must not ask");
    },
    onSystem: () => undefined,
  });
  assert.deepEqual(held, bundleFor(WALLET));
  assert.equal(dashboard.calls.length, 0);
  await assert.rejects(
    ensureWorkspaceDelegation({
      client,
      held: bundleFor(OTHER),
      approveMint: async () => true,
      onSystem: () => undefined,
    }),
    /different wallet/
  );
});
