import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const DEFAULT_INTERRUPT_TERM_MS = 2_000;
const DEFAULT_INTERRUPT_KILL_MS = 5_000;
const INTERRUPTION_WARNING =
  "Interrupt requested, but the command exited normally and may have completed:";

export interface CommandResult {
  status: "completed" | "interrupted";
  output: string;
  exitCode: number;
}

export interface RunningCommand {
  promise: Promise<CommandResult>;
  cancel: () => void;
}

interface StartCommandOptions {
  interruptTermMs?: number;
  interruptKillMs?: number;
}

function signalExitCode(signal: NodeJS.Signals): number {
  switch (signal) {
    case "SIGINT":
      return 130;
    case "SIGTERM":
      return 143;
    case "SIGKILL":
      return 137;
    default:
      return 1;
  }
}

export function startCommand(
  command: string,
  args: string[],
  options: StartCommandOptions = {}
): RunningCommand {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let interruptRequested = false;
  let settled = false;
  let termTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  const interruptTermMs = options.interruptTermMs ?? DEFAULT_INTERRUPT_TERM_MS;
  const interruptKillMs = options.interruptKillMs ?? DEFAULT_INTERRUPT_KILL_MS;

  function clearInterruptTimers(): void {
    if (termTimer) clearTimeout(termTimer);
    if (killTimer) clearTimeout(killTimer);
    termTimer = undefined;
    killTimer = undefined;
  }

  const promise = new Promise<CommandResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearInterruptTimers();
      const interrupted = interruptRequested && signal !== null;
      const output = `${stdout}${stderr}`.trim();
      const warnedOutput = interruptRequested && !interrupted && output
        ? `${INTERRUPTION_WARNING}\n${output}`
        : interruptRequested && !interrupted
          ? INTERRUPTION_WARNING
          : output;

      resolve({
        status: interrupted ? "interrupted" : "completed",
        output: interrupted ? "" : warnedOutput,
        exitCode: code ?? (signal ? signalExitCode(signal) : 1),
      });
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearInterruptTimers();
      reject(err);
    });
  });

  return {
    promise,
    cancel: () => {
      if (settled || interruptRequested) return;
      interruptRequested = true;
      child.kill("SIGINT");
      termTimer = setTimeout(() => {
        if (!settled) child.kill("SIGTERM");
      }, interruptTermMs);
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, interruptKillMs);
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
