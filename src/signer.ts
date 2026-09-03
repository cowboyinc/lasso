/**
 * Local signing for wallet access proofs and protected Cattle Guard transaction
 * requests. Key operations are delegated to the `cowboy` CLI, so key material
 * never enters this process.
 */

import { executeCowboyAsync } from "./executor.js";

export interface EcdsaSignature {
  r: string;
  s: string;
  v: number;
  address?: string;
}

/** Extract the `{r,s,v}` object from `cowboy transaction sign-hash` stdout. The
 *  CLI may print warnings before the JSON, so scan for the last `{...}` line.
 *  Pure + exported for unit testing. */
export function parseSignHashOutput(stdout: string): EcdsaSignature {
  const line = stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith("{"));
  if (!line) {
    throw new Error(`sign-hash: no JSON object in output: ${stdout.slice(0, 200)}`);
  }
  const parsed = JSON.parse(line) as EcdsaSignature;
  if (
    typeof parsed.r !== "string" ||
    typeof parsed.s !== "string" ||
    typeof parsed.v !== "number"
  ) {
    throw new Error(`sign-hash: malformed signature object: ${line.slice(0, 200)}`);
  }
  return {
    r: parsed.r,
    s: parsed.s,
    v: parsed.v,
    ...(typeof parsed.address === "string" ? { address: parsed.address } : {}),
  };
}

/** Sign a prepared 32-byte tx hash with the local key via the `cowboy` CLI.
 *  Throws on CLI failure or malformed output. `signal` (COW-2457) kills the CLI
 *  child if the dispatch times out or the user cancels. */
export async function signHashLocally(
  hashHex: string,
  signal?: AbortSignal,
): Promise<EcdsaSignature> {
  const { stdout, stderr, exitCode } = await executeCowboyAsync(
    ["transaction", "sign-hash", "--hash", hashHex],
    undefined,
    signal,
  );
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim();
    throw new Error(`cowboy sign-hash failed (exit ${exitCode}): ${detail.slice(0, 200)}`);
  }
  return parseSignHashOutput(stdout);
}

/**
 * Sign a transaction digest only after the Cowboy CLI decodes the exact
 * unsigned transaction, recomputes its hash, and confirms that the local key
 * occupies a signer slot. The returned address is checked again here so a
 * different discovered key cannot satisfy a request for the active wallet.
 */
export async function signTransactionHashLocally(
  hashHex: string,
  unsignedTxHex: string,
  expectedAddress: string,
  signal?: AbortSignal
): Promise<EcdsaSignature> {
  const { stdout, stderr, exitCode } = await executeCowboyAsync(
    [
      "transaction",
      "sign-hash",
      "--hash",
      hashHex,
      "--expect-tx-hex",
      unsignedTxHex,
    ],
    undefined,
    signal,
    2 * 1024 * 1024
  );
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim();
    const compatibility = /unrecognized subcommand|unexpected argument/i.test(detail)
      ? " Upgrade the Cowboy CLI to 0.0.34 or newer."
      : "";
    throw new Error(
      `cowboy verified sign-hash failed (exit ${exitCode}): ${detail.slice(0, 400)}${compatibility}`
    );
  }
  const signature = parseSignHashOutput(stdout);
  if (
    typeof signature.address !== "string" ||
    signature.address.toLowerCase() !== expectedAddress.toLowerCase()
  ) {
    throw new Error("cowboy verified sign-hash returned a different wallet address");
  }
  return signature;
}
