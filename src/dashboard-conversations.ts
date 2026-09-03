import {
  WalletAccessProofCache,
  type WalletAccessSigner,
} from "./wallet-access.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface DashboardConversationsClientOptions {
  dashboardUrl: string;
  walletAddress: string;
  signHash?: WalletAccessSigner;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export class DashboardConversationsError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "DashboardConversationsError";
  }
}

function validateDashboardOrigin(value: string): URL {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/+$/, "") !== ""
  ) {
    throw new DashboardConversationsError("Dashboard URL must be an HTTPS origin or HTTP loopback origin");
  }
  return new URL(url.origin);
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new DashboardConversationsError("Dashboard returned an empty response", response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new DashboardConversationsError("Dashboard response exceeded the size limit", response.status);
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DashboardConversationsError("Dashboard returned malformed JSON", response.status);
  }
  if (!response.ok) {
    const detail =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${response.status}`;
    throw new DashboardConversationsError(`Dashboard request failed: ${detail}`, response.status);
  }
  return parsed;
}

export class DashboardConversationsClient {
  private readonly baseUrl: URL;
  private readonly walletAddress: string;
  private readonly fetchFn: typeof fetch;
  private readonly proofCache: WalletAccessProofCache;

  constructor(options: DashboardConversationsClientOptions) {
    this.baseUrl = validateDashboardOrigin(options.dashboardUrl);
    this.walletAddress = options.walletAddress.toLowerCase();
    this.fetchFn = options.fetchFn ?? fetch;
    this.proofCache = new WalletAccessProofCache(
      "conversations",
      this.walletAddress,
      options.signHash,
      options.now
    );
  }

  async createConversation(firstMessage: string, signal?: AbortSignal): Promise<string> {
    const result = (await this.request(
      `/api/conversations`,
      { wallet: this.walletAddress, kind: "builder", firstMessage },
      signal
    )) as { conversation?: { id?: unknown } };
    const id = result.conversation?.id;
    if (typeof id !== "string") {
      throw new DashboardConversationsError("Dashboard conversation response omitted its id");
    }
    return id;
  }

  async registerRun(
    conversationId: string,
    runId: string,
    content: string,
    signal?: AbortSignal
  ): Promise<void> {
    const result = (await this.request(
      `/api/conversations/${encodeURIComponent(conversationId)}/cattle-guard-runs`,
      { runId, content },
      signal
    )) as { runId?: unknown };
    if (typeof result.runId !== "string" || result.runId.toLowerCase() !== runId.toLowerCase()) {
      throw new DashboardConversationsError("Dashboard registered a different Cattle Guard run");
    }
  }

  private async request(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    let retried = false;
    for (;;) {
      const proof = await this.proofCache.proof(signal, retried);
      const response = await this.fetchFn(new URL(path, this.baseUrl), {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-cowboy-conversations-sig": proof.signature,
          "x-cowboy-conversations-ts": proof.timestamp,
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal,
      });
      if (response.status === 401 && !retried) {
        await response.body?.cancel();
        retried = true;
        continue;
      }
      return boundedJson(response);
    }
  }
}
