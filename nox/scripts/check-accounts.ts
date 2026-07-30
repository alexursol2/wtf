/**
 * Pre-flight check. Derives the four role addresses from .env and reports their
 * balances on the target chain, plus whether the NoxCompute deployment and the
 * off-chain gateway are reachable.
 *
 * Run this before any deploy. It answers "am I funded and is the stack up"
 * without spending gas.
 *
 * Private keys are never printed — only derived addresses.
 *
 *   npx hardhat run scripts/check-accounts.ts --network sepolia
 */
import { createPublicClient, http, formatEther } from "viem";
import { loadEnv, roleAddresses, auditorAddress } from "../lib/env.js";

/** Hardcoded in Nox.sol — not configurable. */
const NOX_COMPUTE: Record<number, string> = {
  31337: "0x75C6AF4430cc474b1bb9b8540b7E46D6f8e1C685",
  421614: "0xd464B198f06756a1d00be223634b85E0a731c229",
  11155111: "0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF",
};

/** Rough gas needs, measured with scripts/measure-gas.ts. */
const NEEDS: Record<string, { gas: bigint; note: string }> = {
  DEPLOYER: { gas: 100_000_000n, note: "T-REX suite ~20M + Nox side ~5M, several redeploys" },
  MAKER: { gas: 20_000_000n, note: "postAsk 361k + report/publish/cancel per cycle" },
  TAKER: { gas: 20_000_000n, note: "depositCash 133k + fill 784k per trade" },
  AUDITOR: { gas: 0n, note: "sends NO transactions — decryption is an off-chain signature" },
};

async function main() {
  loadEnv();

  const chainId = Number(process.env.VITE_CHAIN_ID ?? 11155111);
  const rpc =
    chainId === 421614
      ? (process.env.ARB_RPC_URL ?? "https://arbitrum-sepolia-rpc.publicnode.com")
      : (process.env.RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com");

  const client = createPublicClient({ transport: http(rpc) });

  console.log(`\nchain    ${chainId}`);
  console.log(`rpc      ${rpc}`);

  let head: bigint | undefined;
  try {
    head = await client.getBlockNumber();
    const onChainId = await client.getChainId();
    console.log(`head     block ${head}${onChainId === chainId ? "" : `  (WARNING: rpc reports chain ${onChainId})`}`);
  } catch (e: any) {
    console.log(`head     RPC UNREACHABLE — ${e.shortMessage ?? e.message}`);
  }

  // ---- gas price, so the funding advice is grounded ----
  let gasPrice = 0n;
  try {
    gasPrice = await client.getGasPrice();
    console.log(`gas      ${Number(gasPrice) / 1e9} gwei`);
  } catch {
    /* non-fatal */
  }

  // ---- NoxCompute presence ----
  const noxAddress = NOX_COMPUTE[chainId];
  if (!noxAddress) {
    console.log(`\nNoxCompute: chain ${chainId} is NOT supported — Nox reverts "Unsupported chain".`);
  } else {
    try {
      const code = await client.getCode({ address: noxAddress as `0x${string}` });
      const live = code && code.length > 2;
      console.log(`\nNoxCompute ${noxAddress}`);
      console.log(`           ${live ? `deployed (${(code!.length - 2) / 2} bytes)` : "NO CODE — wrong chain?"}`);
    } catch {
      console.log(`\nNoxCompute ${noxAddress}  (could not read code)`);
    }
  }

  // ---- accounts ----
  const addresses = roleAddresses();
  if (Object.keys(addresses).length === 0) {
    console.log("\nNo PRIVATE_KEY_* found in .env — nothing to check.");
    return;
  }

  console.log("\nrole      address                                     balance        verdict");
  console.log("-".repeat(94));

  const shortfalls: { role: string; need: bigint; have: bigint }[] = [];

  for (const [role, address] of Object.entries(addresses)) {
    let balance = 0n;
    try {
      balance = await client.getBalance({ address: address as `0x${string}` });
    } catch {
      /* leave at zero */
    }

    const need = NEEDS[role]?.gas ?? 0n;
    const required = gasPrice > 0n ? need * gasPrice : 0n;

    let verdict: string;
    if (need === 0n) {
      verdict = "ok (needs no gas)";
    } else if (required > 0n && balance < required) {
      verdict = `LOW — wants ~${formatEther(required)} ETH`;
      shortfalls.push({ role, need: required, have: balance });
    } else if (balance === 0n) {
      verdict = "EMPTY";
      shortfalls.push({ role, need: required, have: balance });
    } else {
      verdict = "ok";
    }

    console.log(`${role.padEnd(9)} ${address}  ${formatEther(balance).padStart(12)} ETH  ${verdict}`);
  }

  console.log("-".repeat(94));
  for (const [role, { note }] of Object.entries(NEEDS)) {
    if (addresses[role]) console.log(`${role.padEnd(9)} ${note}`);
  }

  const auditor = auditorAddress();
  console.log(`\nventure constructor will receive auditor = ${auditor ?? "(unset)"}`);
  if (auditor && (auditor === addresses.MAKER || auditor === addresses.TAKER)) {
    console.log("  WARNING: auditor equals maker or taker — the Task 3 disclosure demo proves nothing.");
  }

  // ---- off-chain stack ----
  const gateway = process.env.VITE_NOX_GATEWAY_URL;
  if (gateway) {
    try {
      const res = await fetch(gateway, { signal: AbortSignal.timeout(15_000) });
      console.log(`\ngateway  ${gateway}  HTTP ${res.status}`);
    } catch (e: any) {
      console.log(`\ngateway  ${gateway}  UNREACHABLE (${e.message})`);
    }
  }

  const subgraph = process.env.VITE_NOX_SUBGRAPH_URL;
  if (subgraph) {
    try {
      const res = await fetch(subgraph, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{_meta{block{number}}}" }),
        signal: AbortSignal.timeout(15_000),
      });
      const json: any = await res.json();
      const indexed = json?.data?._meta?.block?.number;
      const lag = head !== undefined && indexed !== undefined ? Number(head) - Number(indexed) : undefined;
      console.log(`subgraph HTTP ${res.status}, indexed block ${indexed ?? "?"}${lag !== undefined ? `  (${lag} behind head)` : ""}`);
    } catch (e: any) {
      console.log(`subgraph UNREACHABLE (${e.message})`);
    }
  }

  if (shortfalls.length > 0) {
    console.log(`\n${shortfalls.length} account(s) need funding. Run:  npx hardhat run scripts/fund-accounts.ts --network sepolia`);
  } else {
    console.log("\nAll funded. Ready to deploy.");
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
