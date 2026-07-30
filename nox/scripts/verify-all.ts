/**
 * Verifies every Layer 2/3 contract on Etherscan, reading addresses and
 * constructor arguments from the deployment record so it stays correct across
 * redeploys.
 *
 * Worth doing for this project in particular: the entire claim is auditable
 * disclosure. An unverified contract asks a reader to take the disclosure logic
 * on trust, which is the opposite of the pitch. A judge should be able to click
 * the venue address and read reportTrade for themselves.
 *
 *   npx hardhat run scripts/verify-all.ts --network sepolia
 */
import { network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { loadEnv } from "../lib/env.js";

interface Target {
  label: string;
  address: string;
  args: (string | number)[];
}

/** Authoritative check. A non-empty SourceCode means the source is published. */
async function isVerifiedOnEtherscan(chainId: number, address: string): Promise<boolean> {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) return false;
  try {
    const res = await fetch(
      `https://api.etherscan.io/v2/api?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}&apikey=${key}`,
      { signal: AbortSignal.timeout(20_000) },
    );
    const json: any = await res.json();
    return (json?.result?.[0]?.SourceCode ?? "").length > 0;
  } catch {
    return false;
  }
}

async function main() {
  loadEnv();

  if (!process.env.ETHERSCAN_API_KEY) {
    throw new Error("ETHERSCAN_API_KEY is not set in .env");
  }

  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  const NETWORK_NAMES: Record<number, string> = {
    421614: "arbitrumSepolia",
    11155111: "sepolia",
  };
  const networkName = NETWORK_NAMES[chainId];
  if (!networkName) throw new Error(`no explorer configured for chain ${chainId}`);

  const record = path.join(import.meta.dirname, "..", "..", "deployments", `venue.${networkName}.json`);
  const d = JSON.parse(fs.readFileSync(record, "utf8"));
  if (d.chainId !== chainId) throw new Error(`record is chain ${d.chainId}, connected to ${chainId}`);

  const targets: Target[] = [
    { label: "DeferralVenue", address: d.venue, args: [d.identityRegistry, d.auditor] },
    { label: "ConfidentialWrapper (bond)", address: d.sharesWrapper, args: [d.bondToken, d.identityRegistry] },
    { label: "ConfidentialWrapper (cash)", address: d.cashWrapper, args: [d.cashToken, d.identityRegistry] },
    { label: "MockERC20 (cash)", address: d.cashToken, args: ["Mock Euro", "mEUR", 6] },
  ];

  console.log(`\nverifying ${targets.length} contracts on ${networkName}\n`);

  const results: [string, string][] = [];

  for (const t of targets) {
    if (!t.address) {
      results.push([t.label, "skipped — not in the deployment record"]);
      continue;
    }

    console.log(`--- ${t.label}  ${t.address}`);

    // The verify task is a CLI task; invoking it as a subprocess keeps the
    // constructor-argument encoding in Hardhat's hands rather than ours.
    const proc = spawnSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["hardhat", "verify", "--network", networkName, t.address, ...t.args.map(String)],
      { encoding: "utf8", cwd: path.join(import.meta.dirname, ".."), shell: process.platform === "win32" },
    );

    const out = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;

    // Do NOT infer the outcome from the CLI's wording — it reports partial
    // successes (Sourcify accepted, Etherscan declined) in prose, and an
    // optimistic regex here once reported "already verified" for contracts that
    // had just been verified for the first time. Ask Etherscan instead.
    const etherscan = await isVerifiedOnEtherscan(chainId, t.address);
    const sourcify = /verified successfully on sourcify/i.test(out);

    if (etherscan) {
      const url = `https://sepolia.etherscan.io/address/${t.address}#code`;
      console.log(`    verified on Etherscan — ${url}`);
      results.push([t.label, "Etherscan"]);
    } else if (sourcify) {
      // Etherscan sometimes declines a small contract whose bytecode it cannot
      // uniquely match, while Sourcify accepts the full solc input. Source is
      // still public, which is the point.
      console.log(`    verified on Sourcify only (Etherscan declined the minimal input)`);
      results.push([t.label, "Sourcify"]);
    } else {
      const reason =
        out
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && /error|fail|reverted|not found/i.test(l))
          .pop() ?? "see output above";
      console.log(`    FAILED: ${reason.slice(0, 160)}`);
      results.push([t.label, `failed — ${reason.slice(0, 90)}`]);
    }
  }

  const width = Math.max(...results.map((r) => r[0].length));
  console.log(`\n--- summary ---`);
  for (const [label, status] of results) console.log(`  ${label.padEnd(width)}  ${status}`);

  const failed = results.filter(([, s]) => s.startsWith("failed"));
  if (failed.length > 0) process.exitCode = 1;
  else console.log(`\nAll verified. Source is readable at sepolia.etherscan.io.\n`);
}

main().catch((e: any) => {
  console.error(`\nfailed: ${e.message}`);
  process.exitCode = 1;
});
