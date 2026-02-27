import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

export function executeCowboyAsync(
  args: string[],
  privateKey?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (privateKey) {
      env.COWBOY_PRIVATE_KEY = privateKey;
    }

    const child = spawn("cowboy", args, { env });

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

export async function deployActor(
  privateKey: string,
  filePath: string,
  validatorUrl: string
): Promise<string> {
  const salt = "0x" + randomBytes(16).toString("hex");

  try {
    const result = await executeCowboyAsync(
      [
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
      ],
      privateKey
    );

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
