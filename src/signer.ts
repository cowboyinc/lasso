/**
 * Local signing for the agent client-tool bridge (COW-2455 / COW-2465).
 *
 * The backend agent prepares a transaction and, via `tool_pending_signature`,
 * sends only its 32-byte hash (`preview.payload.hashHex`). Lasso signs that hash
 * with the local wallet key — delegated to the `cowboy` CLI (`transaction
 * sign-hash`), so key material never enters this process — and posts the raw
 * signature back to `/api/agent/sign-callback`; the backend rebuilds + submits.
 */

import { executeCowboyAsync } from "./executor.js";

export interface EcdsaSignature {
  r: string;
  s: string;
  v: number;
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
  return { r: parsed.r, s: parsed.s, v: parsed.v };
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
