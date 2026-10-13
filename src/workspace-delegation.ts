/**
 * CIP-9 workspace delegation for Cattle Guard runs.
 *
 * A harness runner that serves caller workspaces refuses a turn that carries
 * no `workspaceDelegation`: without it nothing the agent writes survives for
 * the caller. The dashboard attaches the wallet's delegation bundle to the
 * runs it starts; lasso starts runs itself, so it has to obtain the same
 * bundle and attach it.
 *
 * The bundle is minted and stored by the dashboard (one delegation per
 * wallet, shared with the browser). Lasso drives the same two-step mint the
 * Files page uses, signing the two hashes with the project key through the
 * cowboy CLI. Fetching the bundle is a one-time challenge: the dashboard
 * mints a nonce (files-scope proof), returns the statement to sign, and
 * consumes the nonce when the signed statement comes back, so a captured
 * request cannot be replayed. Lasso signs only a statement it fully
 * recognizes: the expected prefix, its own wallet, the nonce it was just
 * given, and the dashboard host it is talking to.
 *
 * The bundle is a delegate credential, so it is never written to disk. It
 * lives in memory for the session and is fetched again on the next launch;
 * a runner refusal drops it so the next turn fetches a fresh one.
 */

import type { WorkspaceDelegationBundle } from "./cattle-guard-client.js";
import { randomUUID } from "node:crypto";
import { encodeFilesSignature, authorizeFilesRequest, dashboardOrigin, filesStatementHash } from "./files-authorization.js";
import { signHashLocally, type EcdsaSignature } from "./signer.js";

const MAX_RESPONSE_BYTES = 256 * 1024;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
export const BUNDLE_STATEMENT_PREFIX = "cowboy-cbfs-delegation-bundle-v1";

export type SignHashFn = (hashHex: string, signal?: AbortSignal) => Promise<EcdsaSignature>;

export class WorkspaceDelegationError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "WorkspaceDelegationError";
  }
}

export interface WorkspaceDelegationClientOptions {
  dashboardUrl: string;
  walletAddress: string;
  signHash?: SignHashFn;
  fetchFn?: typeof fetch;
  now?: () => number;
}

async function boundedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new WorkspaceDelegationError("Dashboard response exceeded the size limit", response.status);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The statement the dashboard asks the wallet to sign, exactly as lasso is
 * willing to sign it. Anything else (another wallet, another host, a nonce
 * lasso was not just given, a different purpose) is refused before the key
 * is touched.
 */
export function expectedBundleStatement(
  walletAddress: string,
  nonce: string,
  dashboardHost: string
): string {
  return `${BUNDLE_STATEMENT_PREFIX}:${walletAddress.toLowerCase()}:${nonce}:${dashboardHost.toLowerCase()}`;
}

/**
 * Accept only a bundle whose delegation names this wallet. The dashboard
 * route already proves the caller, but a bundle for another wallet would
 * silently make the agent write into someone else's volume.
 */
export function validateBundle(raw: unknown, walletAddress: string): WorkspaceDelegationBundle {
  const record = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const key = record?.cbfs_key_enc_b64;
  const delegation = record?.delegation_json;
  const ras = record?.ras_delegation_json;
  if (
    typeof key !== "string" ||
    !key ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(key) ||
    typeof delegation !== "string" ||
    !delegation.trim() ||
    typeof ras !== "string"
  ) {
    throw new WorkspaceDelegationError("Dashboard returned a malformed delegation bundle");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(delegation);
  } catch {
    throw new WorkspaceDelegationError("Dashboard returned an unparsable delegation cert");
  }
  const cert = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const owner = cert?.wallet_address;
  if (typeof owner !== "string" || owner.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new WorkspaceDelegationError("Delegation bundle belongs to a different wallet");
  }
  return { cbfs_key_enc_b64: key, delegation_json: delegation, ras_delegation_json: ras };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export class WorkspaceDelegationClient {
  private readonly baseUrl: URL;
  readonly walletAddress: string;
  private readonly signHash: SignHashFn;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(options: WorkspaceDelegationClientOptions) {
    this.baseUrl = new URL(dashboardOrigin(options.dashboardUrl));
    this.walletAddress = options.walletAddress.toLowerCase();
    this.signHash = options.signHash ?? signHashLocally;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    options: { proof: boolean; signal?: AbortSignal }
  ): Promise<{ status: number; json: unknown }> {
    const payload = body === undefined ? undefined : JSON.parse(JSON.stringify(body));
    const target = new URL(`/api/wallet/${this.walletAddress}/cbfs-delegation${path}`, this.baseUrl);
    const operation = randomUUID();
    const unconfirmed = `The Files operation ${operation} could not be confirmed; check its result before retrying`;
    let retried = false;
    let uncertain = false;
    for (;;) {
      let headers: Record<string, string>;
      try {
        headers = options.proof ? await authorizeFilesRequest({ address: this.walletAddress, audience: this.baseUrl.origin, method, path: target.pathname + target.search, body: payload, operation }, { signHash: this.signHash, fetchFn: this.fetchFn, now: this.now }, options.signal) : {};
      } catch (error) {
        if (uncertain) throw new Error(unconfirmed, { cause: error });
        throw error;
      }
      let response: Response;
      try {
        response = await this.fetchFn(
        target,
        {
          method,
          headers: {
            accept: "application/json",
            "cowboy-client": "lasso",
            ...headers,
            ...(payload === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
          redirect: "error", credentials: "omit",
          signal: options.signal,
        }
      );
      } catch (error) {
        if (options.proof && !retried && error instanceof TypeError && !options.signal?.aborted) { retried = true; uncertain = method !== "GET"; continue; }
        if (method !== "GET") throw new Error(unconfirmed, { cause: error });
        throw error;
      }
      if (options.proof && response.status === 401 && !retried) {
        await response.body?.cancel();
        retried = true;
        continue;
      }
      const text = await boundedText(response);
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          throw new WorkspaceDelegationError("Dashboard returned malformed JSON", response.status);
        }
      }
      const code = asRecord(json)?.code;
      if (options.proof && typeof code === "string" && code.startsWith("FILES_OPERATION_")) {
        throw new WorkspaceDelegationError(`${unconfirmed} (${code})`, response.status);
      }
      if (uncertain && [401, 403, 503].includes(response.status)) {
        throw new WorkspaceDelegationError(unconfirmed, response.status);
      }
      return { status: response.status, json };
    }
  }

  private static detail(json: unknown, status: number): string {
    const record = asRecord(json);
    return typeof record?.error === "string" ? record.error : `HTTP ${status}`;
  }

  /**
   * The active bundle, or null when the wallet has none (stale, pending, or
   * never minted). One challenge, one signature, one fetch.
   */
  async bundle(signal?: AbortSignal): Promise<WorkspaceDelegationBundle | null> {
    const issued = await this.request("POST", "/bundle/challenge", {}, { proof: true, signal });
    if (issued.status !== 200) {
      throw new WorkspaceDelegationError(
        `Dashboard could not issue a delegation challenge: ${WorkspaceDelegationClient.detail(issued.json, issued.status)}`,
        issued.status
      );
    }
    const challenge = asRecord(issued.json);
    const nonce = challenge?.nonce;
    const message = challenge?.message;
    if (typeof nonce !== "string" || !NONCE_RE.test(nonce) || typeof message !== "string") {
      throw new WorkspaceDelegationError("Dashboard returned a malformed delegation challenge");
    }
    const expected = expectedBundleStatement(this.walletAddress, nonce, this.baseUrl.hostname);
    if (message !== expected) {
      throw new WorkspaceDelegationError(
        "Dashboard asked for a signature over a statement lasso does not recognize; refusing to sign"
      );
    }
    const signature = encodeFilesSignature(await this.signHash(filesStatementHash(message), signal));
    const { status, json } = await this.request(
      "POST",
      "/bundle",
      { nonce, signature },
      { proof: false, signal }
    );
    if (status === 404) return null;
    if (status !== 200) {
      throw new WorkspaceDelegationError(
        `Dashboard could not provide the delegation bundle: ${WorkspaceDelegationClient.detail(json, status)}`,
        status
      );
    }
    return validateBundle(json, this.walletAddress);
  }

  /**
   * Mint the wallet's delegation: prepare on the dashboard, sign the cert and
   * RAS hashes with the project key, complete. The dashboard registers the
   * delegation on chain through the RAS write relayer it holds the key for.
   */
  async mint(signal?: AbortSignal): Promise<void> {
    const prepared = await this.request("POST", "/prepare", {}, { proof: true, signal });
    if (prepared.status === 409) {
      // Already active: nothing to sign. The caller fetches the bundle next.
      return;
    }
    if (prepared.status !== 200) {
      throw new WorkspaceDelegationError(
        `Dashboard could not prepare the delegation: ${WorkspaceDelegationClient.detail(prepared.json, prepared.status)}`,
        prepared.status
      );
    }
    const record = asRecord(prepared.json);
    const certHash = record?.certHash;
    const rasHash = record?.rasHash;
    const cert = record?.cert;
    const ras = record?.ras;
    if (
      typeof certHash !== "string" ||
      !HASH_RE.test(certHash) ||
      typeof rasHash !== "string" ||
      !HASH_RE.test(rasHash) ||
      typeof cert !== "string" ||
      !cert ||
      typeof ras !== "string" ||
      !ras
    ) {
      throw new WorkspaceDelegationError("Dashboard returned a malformed delegation to sign");
    }
    const certSig = encodeFilesSignature(await this.signHash(certHash, signal));
    const rasSig = encodeFilesSignature(await this.signHash(rasHash, signal));
    const completed = await this.request(
      "POST",
      "/complete",
      { cert, ras, certSig, rasSig },
      { proof: true, signal }
    );
    if (completed.status !== 200) {
      throw new WorkspaceDelegationError(
        `Dashboard could not complete the delegation: ${WorkspaceDelegationClient.detail(completed.json, completed.status)}`,
        completed.status
      );
    }
  }
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface EnsureWorkspaceDelegationOptions {
  client: WorkspaceDelegationClient;
  /** The bundle held in memory from an earlier turn this session, if any. */
  held: WorkspaceDelegationBundle | null;
  /** Asked once before minting: minting signs two delegation hashes with the
   *  project key and registers the delegation on chain. */
  approveMint: () => Promise<boolean>;
  onSystem: (text: string) => void;
  signal?: AbortSignal;
}

/**
 * The held bundle, else the dashboard's active bundle, else mint one (with
 * approval) and fetch it. Returns null when the user declines to mint; the
 * turn then runs without a workspace and the runner decides whether to
 * accept that. The caller keeps the result in memory for later turns.
 */
export async function ensureWorkspaceDelegation(
  options: EnsureWorkspaceDelegationOptions
): Promise<WorkspaceDelegationBundle | null> {
  const { client, held, signal } = options;
  if (held) return validateBundle(held, client.walletAddress);

  let bundle = await client.bundle(signal);
  if (!bundle) {
    const approved = await options.approveMint();
    if (!approved) {
      options.onSystem(
        "Workspace delegation declined; this turn runs without a cloud workspace and the runner may refuse it."
      );
      return null;
    }
    await client.mint(signal);
    bundle = await client.bundle(signal);
    if (!bundle) {
      throw new WorkspaceDelegationError(
        "Delegation completed but the dashboard reports no active bundle"
      );
    }
    options.onSystem("Workspace delegation created; the agent can now use the workspace volume.");
  }
  return bundle;
}
