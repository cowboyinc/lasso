import { createHash } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { EcdsaSignature } from "./signer.js";

export interface FilesRequest {
  address: string;
  audience: string;
  method: string;
  path: string;
  body: unknown;
  operation: string;
}

export function dashboardOrigin(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Dashboard URL must be an HTTPS origin or HTTP loopback origin");
  }
  return url.origin;
}

export function canonicalFilesBody(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalFilesBody).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalFilesBody((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("Invalid Files request body");
}

export function canonicalFilesPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\#]/.test(path)) throw new Error("Invalid Files request path");
  const url = new URL(path, "http://files-mutation.invalid");
  const entries = [...url.searchParams.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const query = new URLSearchParams(entries).toString();
  return url.pathname + (query ? `?${query}` : "");
}

export function filesRequestStatement(request: FilesRequest, nonce: string): string {
  if (dashboardOrigin(request.audience) !== request.audience || !/^0x[0-9a-f]{40}$/i.test(request.address) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.operation)) {
    throw new Error("Invalid Files authorization context");
  }
  const bodyHash = createHash("sha256").update(canonicalFilesBody(request.body ?? null)).digest("hex");
  const context = JSON.stringify({ address: request.address.toLowerCase(), audience: request.audience,
    method: request.method, path: canonicalFilesPath(request.path), bodyHash, operation: request.operation });
  return `cowboy-files-request-v1:${nonce}:${context}`;
}

export function encodeFilesSignature(sig: EcdsaSignature): string {
  const strip = (value: string): string => {
    const hex = value.replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("Malformed Files signature component");
    return hex.toLowerCase();
  };
  if (!Number.isInteger(sig.v) || sig.v < 0 || sig.v > 255) throw new Error("Malformed Files signature component v");
  return `0x${strip(sig.r)}${strip(sig.s)}${sig.v.toString(16).padStart(2, "0")}`;
}

export function filesStatementHash(statement: string): string {
  return `0x${Buffer.from(keccak_256(new TextEncoder().encode(statement))).toString("hex")}`;
}

type Dependencies = {
  signHash: (hash: string, signal?: AbortSignal) => Promise<EcdsaSignature>;
  fetchFn: typeof fetch;
  now: () => number;
};

export async function authorizeFilesRequest(request: FilesRequest, dependencies: Dependencies, signal?: AbortSignal): Promise<Record<string, string>> {
  const body = request.body === undefined ? undefined : JSON.parse(JSON.stringify(request.body));
  const snapshot = { ...request, body };
  const response = await dependencies.fetchFn(`${request.audience}/api/wallet/${request.address.toLowerCase()}/files/authorization`, {
    method: "POST", redirect: "error", credentials: "omit", signal,
  });
  if (!response.ok) throw new Error(`Files authorization is unavailable (HTTP ${response.status})`);
  const { nonce } = await response.json() as { nonce?: unknown };
  validateFilesNonce(nonce, dependencies.now());
  const signature = await dependencies.signHash(filesStatementHash(filesRequestStatement(snapshot, nonce)), signal);
  return { "x-cowboy-files-request-nonce": nonce, "x-cowboy-files-request-sig": encodeFilesSignature(signature),
    "x-cowboy-files-request-operation": snapshot.operation };
}

export function validateFilesNonce(nonce: unknown, now: number): asserts nonce is string {
  if (typeof nonce !== "string" || !/^\d{13}\.[A-Za-z0-9_-]{43}$/.test(nonce)) throw new Error("Invalid Files authorization challenge");
  const expiry = Number(nonce.split(".")[0]);
  if (expiry <= now || expiry > now + 330_000) throw new Error("Invalid Files authorization challenge expiry");
}

export async function authorizeVolumeCreate(address: string, audience: string, name: string, visibility: string, dependencies: Dependencies, signal?: AbortSignal): Promise<Record<string, string>> {
  const response = await dependencies.fetchFn(`${audience}/api/wallet/${address}/volumes/challenge`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, visibility }),
    redirect: "error", credentials: "omit", signal,
  });
  if (!response.ok) throw new Error(`Volume authorization is unavailable (HTTP ${response.status})`);
  const { nonce } = await response.json() as { nonce?: unknown };
  validateFilesNonce(nonce, dependencies.now());
  const context = JSON.stringify({ address, method: "POST", path: `/api/wallet/${address}/volumes`, name, visibility });
  const signature = await dependencies.signHash(filesStatementHash(`cowboy-volume-create-v1:${nonce}:${context}`), signal);
  return { "x-cowboy-volume-create-nonce": nonce, "x-cowboy-volume-create-sig": encodeFilesSignature(signature) };
}
