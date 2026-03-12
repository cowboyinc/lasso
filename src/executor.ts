import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

export interface CommandResult {
  status: "completed" | "interrupted";
  output: string;
  exitCode: number;
}

export interface RunningCommand {
  promise: Promise<CommandResult>;
  cancel: () => void;
}

export function startCommand(command: string, args: string[]): RunningCommand {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let interrupted = false;
  let settled = false;

  const promise = new Promise<CommandResult>((resolve, reject) => {

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;

      resolve({
        status: interrupted ? "interrupted" : "completed",
        output: interrupted ? "" : `${stdout}${stderr}`.trim(),
        exitCode: code ?? (interrupted ? 130 : 1),
      });
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });

  return {
    promise,
    cancel: () => {
      if (settled || interrupted) return;
      interrupted = true;
      child.kill("SIGINT");
    },
  };
}

export function executeCowboyAsync(
  args: string[]
): Promise<CommandResult> {
  return startCommand("cowboy", args).promise;
}

export async function executeCowboy(
  cowboyArgs: string[],
  validatorUrl: string
): Promise<CommandResult | { status: "error"; output: string }> {
  try {
    const args = ["--indexer-url", validatorUrl, ...cowboyArgs];
    const result = await executeCowboyAsync(args);
    if (result.status === "interrupted") return result;
    return {
      ...result,
      output: result.output || "Command completed (no output)",
    };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { status: "error", output: "Error: cowboy CLI not found. Make sure it is installed and in your PATH." };
    }
    return { status: "error", output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function deployActor(
  filePath: string,
  validatorUrl: string
): Promise<CommandResult | { status: "error"; output: string }> {
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
    if (result.status === "interrupted") return result;
    return {
      ...result,
      output: result.output || "Deploy completed (no output)",
    };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { status: "error", output: "Error: cowboy CLI not found. Make sure it is installed and in your PATH." };
    }
    return { status: "error", output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function startCowboyCommand(
  cowboyArgs: string[],
  validatorUrl: string
): RunningCommand {
  return startCommand("cowboy", ["--indexer-url", validatorUrl, ...cowboyArgs]);
}

export function startDeployActor(
  filePath: string,
  validatorUrl: string
): RunningCommand {
  const salt = "0x" + randomBytes(16).toString("hex");
  return startCommand("cowboy", [
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
}
