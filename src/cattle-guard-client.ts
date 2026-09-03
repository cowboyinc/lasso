import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { VERSION } from "./constants.js";
import {
  WalletAccessProofCache,
  type WalletAccessSigner,
} from "./wallet-access.js";

const PROTOCOL_MAJOR = 1;
const PROTOCOL_MAX_MINOR = 4;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_SSE_BUFFER_BYTES = 10 * 1024 * 1024;
const REFRESH_MARGIN_MS = 15_000;

/**
 * Model role every lasso turn asks for. Cattle Guard resolves a role to a
 * concrete model and harness route; a turn with neither role nor model falls
 * to the default box with no model selected. Lasso turns always carry local
 * client tools, which is the agentic profile.
 */
export const LASSO_MODEL_ROLE = "agentic";

/**
 * Self-description Cattle Guard records per request (`cowboy-client*`
 * headers). Each value must be 1 to 32 printable ASCII bytes with no space
 * and no comma or the server silently drops it, so the platform token joins
 * OS and arch with a dash. These describe a request in traces and the run
 * viewer; authorization never derives from them.
 */
export function clientIdentityHeaders(
  version: string = VERSION,
  platform: string = `${process.platform}-${process.arch}`
): Record<string, string> {
  const token = (value: string): string | null => {
    const cleaned = value.replace(/[^\x21-\x7e]|,/g, "").slice(0, 32);
    return cleaned.length > 0 ? cleaned : null;
  };
  const headers: Record<string, string> = { "cowboy-client": "lasso" };
  const versionToken = token(version);
  if (versionToken) headers["cowboy-client-version"] = versionToken;
  const platformToken = token(platform);
  if (platformToken) headers["cowboy-client-platform"] = platformToken;
  return headers;
}

/** The three files of a cbfs state dir, as the harness expects them. */
export interface WorkspaceDelegationBundle {
  cbfs_key_enc_b64: string;
  delegation_json: string;
  ras_delegation_json: string;
}

export type CattleGuardRunStatus =
  | "queued"
  | "running"
  | "awaiting_input"
  | "interrupting"
  | "completed"
  | "interrupted"
  | "failed";

export type CattleGuardRequestKind =
  | "signature"
  | "question"
  | "approval"
  | "client_tool";

export interface CattleGuardProtocol {
  major: number;
  minor: number;
  minClientMinor: number;
  schemaDigest: string;
  serverBuild: string;
  capabilities: string[];
  limits: Record<string, number>;
}

interface CattleGuardSession {
  runId: string;
  status: CattleGuardRunStatus;
  lastCommittedOrd: number;
  streamUrl: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  idempotentReplay?: boolean;
}

interface JournalFields {
  seq: number;
  ts: number;
  ord: number;
  runId: string;
}

export type CattleGuardEvent = JournalFields & (
  | {
      type: "stream_start";
      protocol: CattleGuardProtocol;
      conversationId: string;
      sessionId: string;
      model: string;
    }
  | { type: "run_status"; status: CattleGuardRunStatus; reason?: string | null }
  | { type: "iteration_start"; iteration: number }
  | { type: "iteration_end"; iteration: number; stopReason: string }
  | { type: "text_delta"; iteration: number; delta: string }
  | { type: "reasoning_delta"; iteration: number; delta: string }
  | {
      type: "tool_use_start";
      iteration: number;
      toolUseId: string;
      toolName: string;
      displayName?: string | null;
    }
  | { type: "tool_use_end"; iteration: number; toolUseId: string; input: unknown }
  | { type: "tool_use_input_delta"; iteration: number; toolUseId: string; delta: string }
  | {
      type: "tool_output_delta";
      iteration: number;
      toolUseId: string;
      channel: string;
      delta: string;
      mode?: string | null;
    }
  | {
      type: "tool_result";
      iteration: number;
      toolUseId: string;
      status: string;
      output: unknown;
      summary?: string | null;
      durationMs: number;
    }
  | {
      type: "plan";
      iteration: number;
      steps: Array<{ text: string; status: "pending" | "in_progress" | "completed" }>;
    }
  | {
      type: "tool_pending_signature";
      iteration: number;
      requestId: string;
      toolUseId: string;
      signingHash: string;
      isBlocking: boolean;
      expiresAt: string;
      preview: unknown;
    }
  | {
      type: "tool_pending_question";
      iteration: number;
      requestId: string;
      toolUseId: string;
      question: string;
      choices: string[];
      isBlocking: boolean;
      expiresAt: string;
    }
  | {
      type: "tool_pending_approval";
      iteration: number;
      requestId: string;
      toolUseId: string;
      toolName: string;
      summary: string;
      isBlocking: boolean;
      expiresAt: string;
    }
  | {
      type: "tool_pending_client_tool";
      iteration: number;
      requestId: string;
      toolUseId: string;
      toolName: string;
      targetClientInstanceId: string;
      isBlocking: boolean;
      expiresAt: string;
      input: unknown;
    }
  | {
      type: "server_request_resolved";
      requestId: string;
      requestKind: CattleGuardRequestKind;
      outcome: string;
      resolvedAt: string;
    }
  | { type: "secret_request"; iteration: number; name: string; reason: string }
  | {
      type: "error";
      iteration?: number | null;
      toolUseId?: string | null;
      message: string;
      recoverable: boolean;
      severity?: string | null;
      code?: string | null;
    }
  | {
      type: "done";
      totalIterations: number;
      finalAssistantContent: string;
      reason: string;
      truncated?: boolean;
    }
  | { type: "harness_info"; version?: string | null; buildId?: string | null }
  | { type: "context_compacted"; [key: string]: unknown }
  | { type: "iteration_usage"; [key: string]: unknown }
  | { type: "stream_degraded"; [key: string]: unknown }
  | { type: "workspace_saved"; [key: string]: unknown }
  | { type: "turn_activity"; [key: string]: unknown }
  | { type: "receipt"; [key: string]: unknown }
);

export interface ProtectedRequestPayload {
  requestId: string;
  runId: string;
  kind: CattleGuardRequestKind;
  expiresAt: string;
  payload: unknown;
}

export interface StartCattleGuardRunOptions {
  conversationId: string;
  query: string;
  clientTools: string[];
  model?: string;
  /** Attached when the wallet has an active CBFS delegation; the harness
   *  mounts the wallet's `workspace` volume for the turn. */
  workspaceDelegation?: WorkspaceDelegationBundle;
  signal?: AbortSignal;
}

export interface CattleGuardClientOptions {
  baseUrl: string;
  walletAddress: string;
  clientInstanceId: string;
  build?: string;
  signHash?: WalletAccessSigner;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export class CattleGuardError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "CattleGuardError";
  }
}

function terminal(status: CattleGuardRunStatus): boolean {
  return status === "completed" || status === "interrupted" || status === "failed";
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function requireUuid(value: string, label: string): string {
  if (!validUuid(value)) throw new CattleGuardError(`invalid ${label}`);
  return value.toLowerCase();
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function validateCattleGuardBaseUrl(value: string): URL {
  const url = new URL(value);
  const validTransport = url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
  if (
    !validTransport ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/+$/, "") !== ""
  ) {
    throw new CattleGuardError("Cattle Guard URL must be an HTTPS origin or an HTTP loopback origin");
  }
  return new URL(url.origin);
}

function validateClientInstanceId(value: string): string {
  if (!validUuid(value)) throw new CattleGuardError("invalid client instance id");
  return value.toLowerCase();
}

export function loadOrCreateClientInstanceId(configDir?: string): string {
  const dir = configDir ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "lasso");
  const path = join(dir, "client.json");
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { clientInstanceId?: unknown };
    if (typeof parsed.clientInstanceId !== "string") {
      throw new CattleGuardError("Lasso client identity file is malformed");
    }
    return validateClientInstanceId(parsed.clientInstanceId);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const clientInstanceId = randomUUID().toLowerCase();
  try {
    writeFileSync(path, JSON.stringify({ clientInstanceId }, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { clientInstanceId?: unknown };
    if (typeof parsed.clientInstanceId !== "string") throw error;
    return validateClientInstanceId(parsed.clientInstanceId);
  }
  return clientInstanceId;
}

async function responseText(response: Response, maximum = MAX_JSON_BYTES): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new CattleGuardError("Cattle Guard response exceeded the size limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function responseJson<T>(response: Response): Promise<T> {
  const text = await responseText(response);
  if (!response.ok) {
    let detail = text.slice(0, 400);
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
      detail = String(parsed.error ?? parsed.message ?? detail);
    } catch {
      // Keep the bounded response text.
    }
    throw new CattleGuardError(`Cattle Guard HTTP ${response.status}: ${detail}`, response.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CattleGuardError("Cattle Guard returned malformed JSON", response.status);
  }
}

interface SseFrame {
  event: string | null;
  id: string | null;
  data: string;
}

function parseSseFrame(frame: string): SseFrame | null {
  let event: string | null = null;
  let id: string | null = null;
  const data: string[] = [];
  for (const raw of frame.split(/\r?\n/)) {
    if (!raw || raw.startsWith(":")) continue;
    const colon = raw.indexOf(":");
    const field = colon < 0 ? raw : raw.slice(0, colon);
    let value = colon < 0 ? "" : raw.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "data") data.push(value);
  }
  return data.length > 0 ? { event, id, data: data.join("\n") } : null;
}

export async function* readCattleGuardSseFrames(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_BUFFER_BYTES) {
        throw new CattleGuardError("Cattle Guard SSE frame exceeded the size limit");
      }
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match || match.index === undefined) break;
        const frame = parseSseFrame(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (frame) yield frame;
      }
    }
  } finally {
    reader.releaseLock();
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const frame = parseSseFrame(buffer);
    if (frame) yield frame;
  }
}

function bearerLooksValid(value: string): boolean {
  return (
    value.length <= 8192 &&
    value.split(".").length === 3 &&
    value.split(".").every((part) => /^[A-Za-z0-9_-]+$/.test(part))
  );
}

function validateSession(raw: CattleGuardSession, baseUrl: URL, now: number): CattleGuardSession {
  if (
    !validUuid(raw.runId) ||
    !Number.isInteger(raw.lastCommittedOrd) ||
    raw.lastCommittedOrd < -1 ||
    !bearerLooksValid(raw.accessToken) ||
    !Number.isFinite(Date.parse(raw.accessTokenExpiresAt)) ||
    Date.parse(raw.accessTokenExpiresAt) <= now
  ) {
    throw new CattleGuardError("Cattle Guard returned an invalid run session");
  }
  const stream = new URL(raw.streamUrl, baseUrl);
  const expectedPath = `/api/agent/runs/${raw.runId.toLowerCase()}/events`;
  const query = [...stream.searchParams.entries()];
  if (
    stream.origin !== baseUrl.origin ||
    stream.username ||
    stream.password ||
    stream.hash ||
    stream.pathname.toLowerCase() !== expectedPath ||
    query.length !== 1 ||
    query[0][0] !== "fromOrd" ||
    query[0][1] !== "0"
  ) {
    throw new CattleGuardError("Cattle Guard returned an unsafe stream URL");
  }
  return { ...raw, runId: raw.runId.toLowerCase(), streamUrl: stream.toString() };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

export class CattleGuardClient {
  readonly baseUrl: URL;
  readonly walletAddress: string;
  readonly clientInstanceId: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly proofCache: WalletAccessProofCache;
  private protocol: CattleGuardProtocol | null = null;
  private readonly build: string;
  private readonly identityHeaders: Record<string, string>;

  constructor(options: CattleGuardClientOptions) {
    this.baseUrl = validateCattleGuardBaseUrl(options.baseUrl);
    this.walletAddress = options.walletAddress.toLowerCase();
    this.clientInstanceId = validateClientInstanceId(options.clientInstanceId);
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
    this.build = (options.build ?? VERSION).slice(0, 128) || "unknown";
    this.identityHeaders = clientIdentityHeaders(this.build);
    this.proofCache = new WalletAccessProofCache(
      "agent",
      this.walletAddress,
      options.signHash,
      this.now
    );
  }

  async negotiate(signal?: AbortSignal): Promise<CattleGuardProtocol> {
    if (this.protocol) return this.protocol;
    const response = await this.fetchFn(new URL("/api/agent/protocol", this.baseUrl), {
      headers: { accept: "application/json", ...this.identityHeaders },
      redirect: "error",
      signal,
    });
    const protocol = await responseJson<CattleGuardProtocol>(response);
    if (
      protocol.major !== PROTOCOL_MAJOR ||
      protocol.minClientMinor > PROTOCOL_MAX_MINOR ||
      protocol.minor < protocol.minClientMinor
    ) {
      throw new CattleGuardError(
        `unsupported Cattle Guard protocol ${protocol.major}.${protocol.minor} (minimum client minor ${protocol.minClientMinor})`
      );
    }
    this.protocol = protocol;
    return protocol;
  }

  async startRun(options: StartCattleGuardRunOptions): Promise<CattleGuardRun> {
    await this.negotiate(options.signal);
    const clientRequestId = randomUUID().toLowerCase();
    const body = {
      walletAddress: this.walletAddress,
      conversationId: options.conversationId,
      clientRequestId,
      harnessSessionId: options.conversationId.toLowerCase(),
      execution: "harness",
      turn: {
        query: options.query,
        modelRole: LASSO_MODEL_ROLE,
        ...(options.model ? { model: options.model } : {}),
        walletAccount: this.walletAddress,
        clientTools: options.clientTools,
        ...(options.workspaceDelegation
          ? { workspaceDelegation: options.workspaceDelegation }
          : {}),
      },
      clientInfo: {
        clientInstanceId: this.clientInstanceId,
        product: "lasso",
        build: this.build,
        protocol: { minMajor: 1, maxMajor: 1, maxMinor: PROTOCOL_MAX_MINOR },
        roles: ["native-client", "authority"],
        capabilities: {
          signing: ["cip15_v2"],
          questions: true,
          clientTools: options.clientTools,
          resumeByOrd: true,
          commandApprovals: true,
        },
      },
    };
    try {
      const session = await this.admissionRequest(
        "/api/agent/client-runs",
        body,
        options.signal,
        { "idempotency-key": clientRequestId }
      );
      return new CattleGuardRun(this, options.conversationId, session);
    } catch (error) {
      if (!(error instanceof CattleGuardError) || error.status !== 409) throw error;
      try {
        const session = await this.recover(options.conversationId, undefined, options.signal);
        return new CattleGuardRun(this, options.conversationId, session);
      } catch (recoveryError) {
        if (recoveryError instanceof CattleGuardError && recoveryError.status === 404) throw error;
        throw recoveryError;
      }
    }
  }

  async recover(
    conversationId: string,
    runId?: string,
    signal?: AbortSignal
  ): Promise<CattleGuardSession> {
    return this.admissionRequest(
      "/api/agent/client-sessions",
      {
        walletAddress: this.walletAddress,
        conversationId,
        ...(runId ? { runId } : {}),
        clientInstanceId: this.clientInstanceId,
      },
      signal
    );
  }

  private async admissionRequest(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    extraHeaders: Record<string, string> = {}
  ): Promise<CattleGuardSession> {
    const proof = await this.proofCache.proof(signal);
    const response = await this.fetchFn(new URL(path, this.baseUrl), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...this.identityHeaders,
        "x-cowboy-agent-sig": proof.signature,
        "x-cowboy-agent-ts": proof.timestamp,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
    return validateSession(
      await responseJson<CattleGuardSession>(response),
      this.baseUrl,
      this.now()
    );
  }

  async bearerRequest<T>(
    session: CattleGuardSession,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    const response = await this.fetchFn(new URL(path, this.baseUrl), {
      method,
      headers: {
        accept: "application/json",
        ...this.identityHeaders,
        authorization: `Bearer ${session.accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal,
    });
    return responseJson<T>(response);
  }

  async streamResponse(
    session: CattleGuardSession,
    fromOrd: number,
    signal: AbortSignal
  ): Promise<Response> {
    const stream = new URL(session.streamUrl);
    stream.search = "";
    stream.searchParams.set("fromOrd", String(fromOrd));
    const response = await this.fetchFn(stream, {
      headers: {
        accept: "text/event-stream",
        ...this.identityHeaders,
        authorization: `Bearer ${session.accessToken}`,
      },
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      await responseJson<never>(response);
    }
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
      throw new CattleGuardError("Cattle Guard stream returned the wrong content type");
    }
    if (!response.body) throw new CattleGuardError("Cattle Guard stream returned an empty body");
    return response;
  }

  tokenNeedsRefresh(session: CattleGuardSession): boolean {
    return Date.parse(session.accessTokenExpiresAt) - this.now() <= REFRESH_MARGIN_MS;
  }
}

export class CattleGuardRun {
  private session: CattleGuardSession;
  private readonly controller = new AbortController();

  constructor(
    private readonly client: CattleGuardClient,
    readonly conversationId: string,
    session: CattleGuardSession
  ) {
    this.session = session;
  }

  get runId(): string {
    return this.session.runId;
  }

  abort(): void {
    this.controller.abort();
  }

  async interrupt(): Promise<void> {
    await this.freshSession();
    await this.client.bearerRequest(
      this.session,
      "POST",
      `/api/agent/runs/${this.runId}/interrupt`,
      {},
      undefined
    );
  }

  async protectedRequest(requestId: string): Promise<ProtectedRequestPayload> {
    const exactRequestId = requireUuid(requestId, "Cattle Guard request id");
    await this.freshSession();
    const result = await this.client.bearerRequest<ProtectedRequestPayload>(
      this.session,
      "GET",
      `/api/agent/requests/${exactRequestId}/payload?runId=${this.runId}`,
      undefined,
      this.controller.signal
    );
    const expiry = Date.parse(result.expiresAt);
    if (
      typeof result.requestId !== "string" ||
      result.requestId.toLowerCase() !== exactRequestId ||
      typeof result.runId !== "string" ||
      result.runId.toLowerCase() !== this.runId ||
      !["signature", "question", "approval", "client_tool"].includes(result.kind) ||
      !Number.isFinite(expiry) ||
      expiry <= Date.now()
    ) {
      throw new CattleGuardError("Cattle Guard returned an invalid protected request");
    }
    return result;
  }

  async respond(
    requestId: string,
    kind: CattleGuardRequestKind,
    response: unknown
  ): Promise<void> {
    const exactRequestId = requireUuid(requestId, "Cattle Guard request id");
    await this.freshSession();
    const receipt = await this.client.bearerRequest<{
      requestId: string;
      runId: string;
      status: string;
    }>(
      this.session,
      "POST",
      `/api/agent/requests/${exactRequestId}/responses`,
      { runId: this.runId, kind, response },
      this.controller.signal
    );
    if (
      typeof receipt.requestId !== "string" ||
      receipt.requestId.toLowerCase() !== exactRequestId ||
      typeof receipt.runId !== "string" ||
      receipt.runId.toLowerCase() !== this.runId ||
      receipt.status !== "response_recorded"
    ) {
      throw new CattleGuardError("Cattle Guard returned an invalid response receipt");
    }
  }

  async *events(): AsyncGenerator<CattleGuardEvent> {
    let nextOrd = 0;
    let retry = 0;
    while (!this.controller.signal.aborted) {
      await this.freshSession();
      try {
        const response = await this.client.streamResponse(
          this.session,
          nextOrd,
          this.controller.signal
        );
        let madeProgress = false;
        for await (const frame of readCattleGuardSseFrames(response.body!)) {
          if (frame.event === "transport_cursor") {
            const cursor = JSON.parse(frame.data) as { nextOrd?: unknown };
            if (typeof cursor.nextOrd === "number" && cursor.nextOrd > nextOrd) {
              throw new CattleGuardError("Cattle Guard cursor advanced past an unseen event");
            }
            continue;
          }
          if (frame.event === "transport_error") {
            throw new CattleGuardError("Cattle Guard requested a stream retry");
          }
          let event: CattleGuardEvent;
          try {
            event = JSON.parse(frame.data) as CattleGuardEvent;
          } catch {
            throw new CattleGuardError("Cattle Guard emitted malformed event JSON");
          }
          if (
            event.runId?.toLowerCase() !== this.runId ||
            !Number.isInteger(event.ord) ||
            event.ord < 0 ||
            typeof event.type !== "string"
          ) {
            throw new CattleGuardError("Cattle Guard emitted an invalid run event");
          }
          if (event.ord < nextOrd) continue;
          if (event.ord > nextOrd) {
            throw new CattleGuardError(
              `Cattle Guard event gap: expected ordinal ${nextOrd}, received ${event.ord}`
            );
          }
          if (frame.id !== null && Number(frame.id) !== event.ord) {
            throw new CattleGuardError("Cattle Guard SSE id does not match the event ordinal");
          }
          nextOrd = event.ord + 1;
          madeProgress = true;
          retry = 0;
          if (
            event.type === "tool_pending_client_tool" &&
            (typeof event.targetClientInstanceId !== "string" ||
              event.targetClientInstanceId.toLowerCase() !== this.client.clientInstanceId)
          ) {
            continue;
          }
          yield event;
          if (event.type === "run_status" && terminal(event.status)) return;
        }
        if (madeProgress) retry = 0;
      } catch (error) {
        if (this.controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (error instanceof CattleGuardError && error.status === 401) {
          this.session = await this.client.recover(
            this.conversationId,
            this.runId,
            this.controller.signal
          );
          continue;
        }
        retry += 1;
        if (retry > 8) throw error;
      }
      if (this.client.tokenNeedsRefresh(this.session)) {
        this.session = await this.client.recover(
          this.conversationId,
          this.runId,
          this.controller.signal
        );
      }
      await abortableDelay(Math.min(250 * 2 ** retry, 4_000), this.controller.signal);
    }
    throw new DOMException("Aborted", "AbortError");
  }

  private async freshSession(): Promise<void> {
    if (!this.client.tokenNeedsRefresh(this.session)) return;
    const expectedRunId = this.runId;
    const refreshed = await this.client.recover(
      this.conversationId,
      expectedRunId,
      this.controller.signal
    );
    if (refreshed.runId !== expectedRunId) {
      throw new CattleGuardError("Cattle Guard refreshed a different run");
    }
    this.session = refreshed;
  }
}
