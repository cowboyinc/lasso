import { keccak_256 } from "@noble/hashes/sha3.js";
import { signHashLocally, type EcdsaSignature } from "./signer.js";

const BUCKET_MS = 3_600_000;

export type WalletAccessScope = "agent" | "conversations";

export interface WalletAccessProof {
  signature: string;
  timestamp: string;
}

export type WalletAccessSigner = (
  hashHex: string,
  signal?: AbortSignal
) => Promise<EcdsaSignature>;

export function walletAccessBucket(nowMs: number): number {
  return Math.floor(nowMs / BUCKET_MS);
}

export function walletAccessHashHex(
  scope: WalletAccessScope,
  address: string,
  bucket: number
): string {
  const message = `cowboy-${scope}-access:${address.toLowerCase()}:${bucket}`;
  const digest = keccak_256(new TextEncoder().encode(message));
  return `0x${Buffer.from(digest).toString("hex")}`;
}

export function encodeRecoverableSignature(signature: EcdsaSignature): string {
  const component = (value: string, name: string): string => {
    const normalized = value.replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
      throw new Error(`wallet proof: malformed signature component ${name}`);
    }
    return normalized.toLowerCase();
  };
  if (!Number.isInteger(signature.v) || signature.v < 0 || signature.v > 255) {
    throw new Error("wallet proof: malformed signature component v");
  }
  return `0x${component(signature.r, "r")}${component(signature.s, "s")}${signature.v
    .toString(16)
    .padStart(2, "0")}`;
}

export class WalletAccessProofCache {
  private cached: { bucket: number; proof: WalletAccessProof } | null = null;

  constructor(
    private readonly scope: WalletAccessScope,
    private readonly address: string,
    private readonly signHash: WalletAccessSigner = signHashLocally,
    private readonly now: () => number = Date.now
  ) {}

  async proof(signal?: AbortSignal, force = false): Promise<WalletAccessProof> {
    const bucket = walletAccessBucket(this.now());
    if (!force && this.cached?.bucket === bucket) return this.cached.proof;
    const signature = await this.signHash(
      walletAccessHashHex(this.scope, this.address, bucket),
      signal
    );
    const proof = {
      signature: encodeRecoverableSignature(signature),
      timestamp: String(bucket),
    };
    this.cached = { bucket, proof };
    return proof;
  }
}
