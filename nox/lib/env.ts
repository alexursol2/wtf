/**
 * Shared .env loading for the Nox sub-project.
 *
 * `.env` lives at the repo root (one level above this sub-project) so a single
 * file serves both Hardhat projects and the frontend.
 *
 * Keys are normalised to 0x-prefixed form: a raw 64-char hex private key is the
 * form most wallets export, but viem and ethers both require the prefix.
 *
 * NEVER log a private key from here, or from anything that calls it. The
 * helpers below deliberately expose addresses only.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http, type Hex, type WalletClient } from "viem";
import { sepolia, arbitrumSepolia, hardhat } from "viem/chains";

let loaded = false;

/** Reads ../.env into process.env without overwriting anything already set. */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;

  // import.meta.dirname is nox/lib, so the repo root is two levels up.
  const envPath = path.join(import.meta.dirname, "..", "..", ".env");
  if (!fs.existsSync(envPath)) return;

  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // strip matching surrounding quotes
    if (value.length >= 2 && /^["'].*["']$/.test(value)) value = value.slice(1, -1);
    if (value !== "" && process.env[key] === undefined) process.env[key] = value;
  }
}

/** Adds the 0x prefix if missing. Returns undefined for an unset/blank key. */
export function normalizeKey(raw: string | undefined): Hex | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const withPrefix = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    throw new Error(
      `malformed private key (expected 64 hex chars, got ${trimmed.length}). Not printing the value.`,
    );
  }
  return withPrefix as Hex;
}

export const ROLES = ["DEPLOYER", "MAKER", "TAKER", "AUDITOR"] as const;
export type Role = (typeof ROLES)[number];

/**
 * True when a decrypt failure means "wait", not "denied" or "broken".
 *
 * There are THREE transient classes, and only two of them are exported from
 * `@iexec-nox/handle`:
 *
 *  - NotYetComputedHandleError — the TEE Runner has not resolved it yet.
 *  - UnknownHandleError        — the indexer has not seen the handle yet.
 *  - SubgraphOutOfSyncError    — the subgraph trails the chain head. This one is
 *    thrown but NOT exported, so it cannot be caught with `instanceof` and has
 *    to be matched on its message. It fires on a lag as small as one block, and
 *    treating it as fatal makes a perfectly good value look permanently
 *    unreadable — which is exactly the mistake this helper exists to prevent.
 */
export function isTransient(e: unknown): boolean {
  const name = (e as any)?.constructor?.name ?? "";
  if (
    name === "NotYetComputedHandleError" ||
    name === "UnknownHandleError" ||
    name === "SubgraphOutOfSyncError"
  ) {
    return true;
  }
  const message = (e as any)?.message ?? "";
  return /not yet computed|unknown handle|out of sync/i.test(message);
}

/** Private keys by role, in the order Hardhat should register them as signers. */
export function roleKeys(): { role: Role; key: Hex }[] {
  loadEnv();
  const out: { role: Role; key: Hex }[] = [];
  for (const role of ROLES) {
    const key = normalizeKey(process.env[`PRIVATE_KEY_${role}`]);
    if (key) out.push({ role, key });
  }
  return out;
}

/** Just the keys, for a Hardhat `accounts` array. Order matches ROLES. */
export function accountsArray(): Hex[] {
  return roleKeys().map((r) => r.key);
}

/** Role → address. Safe to log. */
export function roleAddresses(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { role, key } of roleKeys()) {
    out[role] = privateKeyToAccount(key).address;
  }
  return out;
}

/**
 * The auditor address the venue constructor is given.
 *
 * Prefers an explicit AUDITOR, but falls back to the address derived from
 * PRIVATE_KEY_AUDITOR — the auditor signs no transactions, so requiring the
 * address to be pasted separately is just an extra chance to get it wrong.
 */
export function auditorAddress(): string | undefined {
  loadEnv();
  const explicit = process.env.AUDITOR?.trim();
  if (explicit) return explicit;
  const key = normalizeKey(process.env.PRIVATE_KEY_AUDITOR);
  return key ? privateKeyToAccount(key).address : undefined;
}

/**
 * A viem WalletClient holding EXACTLY ONE account, for use with
 * `@iexec-nox/handle`.
 *
 * This is not a convenience — it is required for correctness. The SDK's
 * ViemBlockchainService resolves the signer via `walletClient.getAddresses()[0]`
 * and ignores `walletClient.account`. A Hardhat wallet client shares one
 * transport whose `eth_accounts` lists every configured key, so EVERY party's
 * client reports the first account (the deployer). The gateway then binds the
 * input proof to the wrong owner, and the venue reverts at validateInputProof
 * with an opaque `0xae385f38` (InvalidProof / owner mismatch).
 *
 * Building a dedicated client per role makes `getAddresses()` return that role's
 * address and nothing else.
 */
export function roleWalletClient(role: Role, chainId: number): WalletClient {
  loadEnv();

  const key = normalizeKey(process.env[`PRIVATE_KEY_${role}`]);
  if (!key) throw new Error(`PRIVATE_KEY_${role} is not set in .env`);

  const rpcUrl =
    chainId === 421614
      ? (process.env.ARB_RPC_URL ?? "https://arbitrum-sepolia-rpc.publicnode.com")
      : chainId === 11155111
        ? (process.env.RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com")
        : "http://127.0.0.1:8545";

  const chain =
    chainId === 421614 ? arbitrumSepolia : chainId === 11155111 ? sepolia : hardhat;

  return createWalletClient({
    account: privateKeyToAccount(key),
    chain,
    transport: http(rpcUrl),
  });
}
