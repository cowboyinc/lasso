import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function executeCowboyAsync(
  args: string[],
  stdin?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    // Default stdio (all three piped) lets us write the optional `stdin`
    // payload to the child out-of-band, instead of placing the secret on argv
    // where `ps` / `/proc/<pid>/cmdline` would expose it. For commands that
    // do not consume stdin we simply close the pipe without writing.
    const child = spawn("cowboy", args);

    if (stdin !== undefined) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

export interface CowboyResult {
  text: string;
  /** True when the CLI ran and exited 0. */
  ok: boolean;
}

export async function executeCowboy(
  cowboyArgs: string[],
  validatorUrl: string,
  stdin?: string,
): Promise<CowboyResult> {
  try {
    const args = ["--indexer-url", validatorUrl, ...cowboyArgs];
    const result = await executeCowboyAsync(args, stdin);

    let output = result.stdout;
    if (result.stderr) {
      output += result.stderr;
    }
    return {
      text: output.trim() || (result.exitCode === 0 ? "Command completed (no output)" : `Command failed (exit ${result.exitCode})`),
      ok: result.exitCode === 0,
    };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return {
        text: "Error: cowboy CLI not found. Make sure it is installed and in your PATH.\nInstall it with: brew install cowboyinc/lasso/cowboy",
        ok: false,
      };
    }
    return { text: `Error: ${err instanceof Error ? err.message : String(err)}`, ok: false };
  }
}

export async function getCowboyVersion(): Promise<string | null> {
  try {
    const result = await executeCowboyAsync(["version"]);
    const match = result.stdout.trim().match(/cowboy\s+([\d.]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export interface ActorInfo {
  address: string;
  deployer: string;
  balance: number;
  nonce: number;
  storage_size: number | null;
  deploy_height: number | null;
  code_hash: string | null;
}

export interface ActorDetail {
  address: string;
  code_hash: string;
  balance: number;
  nonce: number;
  mailbox_count: number;
  storage: Record<string, string>;
}

export interface RunnerRateCard {
  llm_input_token: number;
  llm_output_token: number;
  http_request_base: number;
  compute_second: number;
  memory_mb: number;
  supported_models: string[];
  min_job_value: number;
  max_job_value: number;
  cooldown_blocks: number;
  last_updated: number;
}

export interface RunnerCapabilities {
  job_types: string[];
  tee_support: string | null;
  regions: string[];
  http_domains: string[];
  max_concurrent_jobs: number;
}

export interface RunnerInfo {
  address: string;
  public_key?: string;
  stake: number;
  rate_card: RunnerRateCard;
  capabilities: RunnerCapabilities;
  health: string;
  registered_at: number;
  last_heartbeat: number;
  reputation: number;
  active_jobs: number;
}

export interface JobStatusInfo {
  job_id: string;
  status: string;
}

export interface JobResultInfo {
  job_id: string;
  runner: string;
  data: unknown;
  usage: {
    input_tokens: number;
    output_tokens: number;
    wall_time_seconds: number;
    memory_mb: number;
  };
  tee_attestation: string | null;
  source_attestation: unknown;
  timestamp: number;
}

export interface VerifiedJobResult {
  job_id: string;
  data: unknown;
  consensus_count: number;
  total_runners: number;
}

export interface SubmittedLlmJob {
  txHash: string;
  rawOutput: string;
}

export interface ResolvedLlmJob {
  jobId: string | null;
  status: string;
  data: unknown | null;
}

const HEX_ADDRESS_RE = /^(0x)?[a-fA-F0-9]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export async function detectWalletAddress(): Promise<string | null> {
  try {
    const result = await executeCowboyAsync(["wallet", "address"]);
    const match = result.stdout.trim().match(/^(0x[a-fA-F0-9]{40})$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { message?: string } | null;
    throw new Error(body?.message ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

function appendUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path}`;
}

export interface FaucetResult {
  status: string;
  txHash: string;
  amountCby: number;
}

export async function requestFaucet(
  validatorUrl: string,
  address: string
): Promise<FaucetResult> {
  if (!HEX_ADDRESS_RE.test(address)) {
    throw new Error(`Invalid address format: ${address}`);
  }
  const res = await fetch(appendUrl(validatorUrl, "/faucet"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const message = typeof body?.message === "string" ? body.message : `Faucet request failed (${res.status})`;
    throw new Error(message);
  }
  return {
    status: String(body?.status ?? "accepted"),
    txHash: String(body?.tx_hash ?? ""),
    amountCby: Number(body?.amount_cby ?? 0),
  };
}

/**
 * Fetch an account's balance. Accounts that have never received funds
 * return 404 from the node, which maps to a balance of 0.
 * Returns null when the balance could not be determined.
 */
export async function fetchAccountBalance(
  validatorUrl: string,
  address: string
): Promise<number | null> {
  if (!HEX_ADDRESS_RE.test(address)) {
    return null;
  }
  try {
    const res = await fetch(appendUrl(validatorUrl, `/account/${encodeURIComponent(address)}`));
    if (res.status === 404) return 0;
    if (!res.ok) return null;
    const body = (await res.json()) as { balance?: number };
    return typeof body.balance === "number" ? body.balance : null;
  } catch {
    return null;
  }
}

export async function fetchActorDetail(
  validatorUrl: string,
  address: string
): Promise<ActorDetail> {
  if (!HEX_ADDRESS_RE.test(address)) {
    throw new Error(`Invalid address format: ${address}`);
  }
  const clean = address.replace(/^0x/, "");
  return fetchJson<ActorDetail>(
    appendUrl(validatorUrl, `/actor/${encodeURIComponent(clean)}`)
  );
}

export async function fetchMyActors(
  dashboardUrl: string,
  walletAddress: string
): Promise<ActorInfo[]> {
  if (!HEX_ADDRESS_RE.test(walletAddress)) {
    throw new Error(`Invalid wallet address format: ${walletAddress}`);
  }
  const clean = walletAddress.replace(/^0x/, "");
  const data = await fetchJson<{ actors: Record<string, unknown>[] }>(
    appendUrl(dashboardUrl, `/api/wallet/${encodeURIComponent(clean)}/actors`)
  );
  return (data.actors ?? []).map((a) => ({
    address: String(a.address ?? ""),
    deployer: String(a.deployer ?? ""),
    balance: Number(a.balance ?? 0),
    nonce: Number(a.nonce ?? 0),
    storage_size: a.storageSize != null ? Number(a.storageSize) : null,
    deploy_height: a.deployHeight != null ? Number(a.deployHeight) : null,
    code_hash: a.codeHash ? String(a.codeHash) : null,
  }));
}

export async function fetchActiveRunners(
  validatorUrl: string
): Promise<RunnerInfo[]> {
  const data = await fetchJson<{ runners: RunnerInfo[] }>(
    appendUrl(validatorUrl, "/runners/active")
  );
  return data.runners ?? [];
}

export async function fetchRunnerDetail(
  validatorUrl: string,
  address: string
): Promise<RunnerInfo> {
  return fetchJson<RunnerInfo>(
    appendUrl(validatorUrl, `/runner/${encodeURIComponent(address)}`)
  );
}

export async function fetchJobStatus(
  validatorUrl: string,
  jobId: string
): Promise<JobStatusInfo> {
  return fetchJson<JobStatusInfo>(
    appendUrl(validatorUrl, `/job/${encodeURIComponent(jobId)}/status`)
  );
}

export async function fetchJobResults(
  validatorUrl: string,
  jobId: string
): Promise<{ job_id: string; total_count: number; results: JobResultInfo[] }> {
  return fetchJson<{ job_id: string; total_count: number; results: JobResultInfo[] }>(
    appendUrl(validatorUrl, `/job/${encodeURIComponent(jobId)}/results`)
  );
}

export async function fetchJobVerified(
  validatorUrl: string,
  jobId: string
): Promise<VerifiedJobResult> {
  return fetchJson<VerifiedJobResult>(
    appendUrl(validatorUrl, `/job/${encodeURIComponent(jobId)}/verified`)
  );
}

async function fetchTransactionReceipt(
  validatorUrl: string,
  txHash: string
): Promise<{ block_height: number } | null> {
  const clean = txHash.replace(/^0x/, "");
  const res = await fetch(appendUrl(validatorUrl, `/transaction/${encodeURIComponent(clean)}/receipt`));
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || `Receipt query failed (${res.status})`);
  }
  return (await res.json()) as { block_height: number };
}

function parseCowboyOutput(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}${result.stderr}`.trim() || "Command completed (no output)";
}

function extractTransactionHash(raw: string): string | null {
  const match = raw.match(/Transaction hash:\s*(0x)?([a-fA-F0-9]{64})/i);
  if (!match) return null;
  return `0x${match[2]}`;
}

async function ensureTempDir(): Promise<string> {
  const base = join(tmpdir(), "lasso-");
  await mkdir(tmpdir(), { recursive: true });
  return mkdtemp(base);
}

function createLlmJobSpec(prompt: string, callbackActor: string | null): Record<string, unknown> {
  const maxTokens = 1024;
  return {
    job_id: Array(32).fill(0),
    job_type: {
      type: "Llm",
      model_id: Array(32).fill(0),
      prompt,
      system_prompt: null,
      temperature: null,
      max_tokens: maxTokens,
      response_model: null,
    },
    bounds: {
      max_input_tokens: 8192,
      max_output_tokens: maxTokens,
      max_wall_time_seconds: 120,
      max_memory_mb: 1024,
      max_retries: 0,
    },
    verification: {
      mode: "none",
      runners: 1,
      threshold: 1,
      checks: [],
      tee_required: false,
      dispute_window_blocks: 75,
    },
    max_price: 0,
    tip: 0,
    timeout_blocks: 120,
    callback: {
      actor: callbackActor ?? ZERO_ADDRESS,
      handler: "",
      payload: null,
      correlation_id: "",
      context: [],
    },
    submitter: ZERO_ADDRESS,
    submitted_at: 0,
  };
}

export async function submitLlmJob(
  prompt: string,
  validatorUrl: string,
  walletAddress: string | null
): Promise<SubmittedLlmJob> {
  const tempDir = await ensureTempDir();
  const filePath = join(tempDir, `job-${randomBytes(4).toString("hex")}.json`);

  try {
    await writeFile(
      filePath,
      JSON.stringify(createLlmJobSpec(prompt, walletAddress), null, 2) + "\n",
      "utf-8"
    );

    const result = await executeCowboyAsync([
      "--indexer-url",
      validatorUrl,
      "job",
      "submit",
      "--job-spec",
      filePath,
    ]);

    const rawOutput = parseCowboyOutput(result);
    const txHash = extractTransactionHash(rawOutput);
    if (!txHash) {
      throw new Error(rawOutput || "Could not extract transaction hash from cowboy output.");
    }

    return { txHash, rawOutput };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new Error("cowboy CLI not found. Make sure it is installed and in your PATH.");
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function deriveJobId(txHash: string, blockHeight: number): string {
  const txBytes = Buffer.from(txHash.replace(/^0x/, ""), "hex");
  const blockBytes = Buffer.alloc(8);
  blockBytes.writeBigUInt64BE(BigInt(blockHeight));
  const digest = createHash("sha256").update(txBytes).update(blockBytes).digest("hex");
  return `0x${digest}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForJobId(
  validatorUrl: string,
  txHash: string,
  timeoutMs = 30_000
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await fetchTransactionReceipt(validatorUrl, txHash);
    if (receipt?.block_height != null) {
      return deriveJobId(txHash, receipt.block_height);
    }
    await sleep(2_000);
  }
  return null;
}

export async function waitForLlmJobResult(
  validatorUrl: string,
  jobId: string,
  timeoutMs = 90_000
): Promise<ResolvedLlmJob> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const verified = await fetchJobVerified(validatorUrl, jobId);
      return { jobId, status: "verified", data: verified.data };
    } catch {
      // Fall back to raw results while the verified endpoint catches up.
    }

    try {
      const results = await fetchJobResults(validatorUrl, jobId);
      if (results.results.length > 0) {
        return { jobId, status: "completed", data: results.results[0].data };
      }
    } catch {
      // Keep polling until timeout.
    }

    await sleep(2_000);
  }

  try {
    const status = await fetchJobStatus(validatorUrl, jobId);
    return { jobId, status: status.status, data: null };
  } catch {
    return { jobId, status: "pending", data: null };
  }
}

export async function deployActor(
  filePath: string,
  validatorUrl: string
): Promise<CowboyResult> {
  const salt = "0x" + randomBytes(16).toString("hex");

  try {
    const result = await executeCowboyAsync([
      "--indexer-url",
      validatorUrl,
      "actor",
      "deploy",
      "--code",
      filePath,
      "--salt",
      salt,
      "--cycles-limit",
      "10000000",
      "--cells-limit",
      "10000000",
    ]);

    return { text: parseCowboyOutput(result), ok: result.exitCode === 0 };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return {
        text: "Error: cowboy CLI not found. Make sure it is installed and in your PATH.\nInstall it with: brew install cowboyinc/lasso/cowboy",
        ok: false,
      };
    }
    return { text: `Error: ${err instanceof Error ? err.message : String(err)}`, ok: false };
  }
}
