/**
 * .env loading for the T-REX sub-project.
 *
 * Deliberately duplicated from nox/lib/env.ts rather than shared: this project
 * is CommonJS on Hardhat 2 / solc 0.8.17 and cannot import the ESM module from
 * the Nox side. The two projects can never share a toolchain — that constraint
 * is the reason they are separate in the first place.
 *
 * NEVER log a private key from here or from any caller.
 */
import * as fs from "fs";
import * as path from "path";

let loaded = false;

/** Reads ../.env into process.env without overwriting anything already set. */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;

  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;

  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && /^["'].*["']$/.test(value)) value = value.slice(1, -1);
    if (value !== "" && process.env[key] === undefined) process.env[key] = value;
  }
}

function normalizeKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const withPrefix = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    throw new Error(
      `malformed private key (expected 64 hex chars, got ${trimmed.length}). Not printing the value.`,
    );
  }
  return withPrefix;
}

/**
 * Signer keys in role order: DEPLOYER, MAKER, TAKER, AUDITOR.
 *
 * deploy-trex.ts indexes on this order. The maker and taker must be distinct
 * accounts, or the venue's fill path writes both sides of the cash transfer to
 * one storage slot.
 */
export function accountsArray(): string[] {
  loadEnv();
  const roles = ["DEPLOYER", "MAKER", "TAKER", "AUDITOR"];
  const keys: string[] = [];
  for (const role of roles) {
    const key = normalizeKey(process.env[`PRIVATE_KEY_${role}`]);
    if (key) keys.push(key);
  }
  return keys;
}
