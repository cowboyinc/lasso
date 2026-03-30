import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

export function executeCowboyAsync(
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("cowboy", args);

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

export async function executeCowboy(
  cowboyArgs: string[],
  validatorUrl: string
): Promise<string> {
  try {
    const args = ["--indexer-url", validatorUrl, ...cowboyArgs];
    const result = await executeCowboyAsync(args);

    let output = result.stdout;
    if (result.stderr) {
      output += result.stderr;
    }
    return output.trim() || "Command completed (no output)";
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return "Error: cowboy CLI not found. Make sure it is installed and in your PATH.";
    }
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
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

export async function detectWalletAddress(): Promise<string | null> {
  try {
    const result = await executeCowboyAsync(["wallet", "address"]);
    const match = result.stdout.trim().match(/^(0x[a-fA-F0-9]{40})$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export interface ActorDetail {
  address: string;
  code_hash: string;
  balance: number;
  nonce: number;
  mailbox_count: number;
  storage: Record<string, string>;
}

export async function fetchActorDetail(
  validatorUrl: string,
  address: string
): Promise<ActorDetail> {
  const clean = address.replace(/^0x/, "");
  const url = `${validatorUrl}/actor/${clean}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { message?: string } | null;
    throw new Error(body?.message ?? `Actor not found (${res.status})`);
  }
  return (await res.json()) as ActorDetail;
}

export async function fetchMyActors(
  dashboardUrl: string,
  walletAddress: string
): Promise<ActorInfo[]> {
  const clean = walletAddress.replace(/^0x/, "");
  const url = `${dashboardUrl}/api/wallet/${clean}/actors`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Dashboard returned ${res.status}`);
  const data = (await res.json()) as { actors: Record<string, unknown>[] };
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

export async function deployActor(
  filePath: string,
  validatorUrl: string
): Promise<string> {
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

    let output = result.stdout;
    if (result.stderr) {
      output += result.stderr;
    }
    return output.trim() || "Deploy completed (no output)";
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return "Error: cowboy CLI not found. Make sure it is installed and in your PATH.";
    }
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
