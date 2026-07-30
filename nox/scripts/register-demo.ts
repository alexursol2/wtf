/**
 * The grant-on-demand beat, end to end on a live chain.
 *
 * Filmed on the HOLDER REGISTER, not on fill volumes — and that distinction is
 * the whole point. Fill volumes are granted to the auditor at the moment of the
 * fill, because the regulator has to see a trade before the public deferral
 * elapses. So a fill has no "before" state to show. The register does: it is
 * disclosed by the issuer, on request, one holder at a time.
 *
 * The sequence:
 *   1. the maker wraps real T-REX bonds  -> an encrypted balance exists
 *   2. the auditor tries to read it      -> DENIED, no grant
 *   3. the issuer grants access          -> addViewer
 *   4. the auditor reads it              -> the actual number
 *
 * Step 2 is the part worth filming. Almost nobody demonstrates the negative.
 *
 *   npx hardhat run scripts/register-demo.ts --network sepolia
 */
import { network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { createViemHandleClient } from "@iexec-nox/handle";
import { parseUnits, formatUnits, type Hex } from "viem";
import { loadEnv, roleWalletClient, isTransient } from "../lib/env.js";

const WRAP_AMOUNT = parseUnits("2500", 18);
const POLL_MS = 5_000;
const TIMEOUT_MS = 120_000;

const ERC20_ABI = [
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const NOX = "0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF" as const;
const IS_VIEWER_ABI = [
  { name: "isViewer", type: "function", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] },
] as const;

async function main() {
  loadEnv();
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const [issuer, maker, , auditor] = await viem.getWalletClients();

  const recordPath = path.join(import.meta.dirname, "..", "..", "deployments", "venue.sepolia.json");
  const d = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  if (d.chainId !== chainId) throw new Error(`record is chain ${d.chainId}, connected to ${chainId}`);

  const wrapper = await viem.getContractAt("ConfidentialWrapper", d.sharesWrapper);
  const auditorAddr = auditor.account.address;

  console.log(`\n=== holder register: grant on demand ===`);
  console.log(`wrapper  ${d.sharesWrapper}`);
  console.log(`bond     ${d.bondToken}`);
  console.log(`issuer   ${issuer.account.address}`);
  console.log(`holder   ${maker.account.address}`);
  console.log(`auditor  ${auditorAddr}\n`);

  const nonces = new Map<string, number>();
  for (const c of [issuer, maker]) {
    nonces.set(
      c.account.address,
      await publicClient.getTransactionCount({ address: c.account.address, blockTag: "pending" }),
    );
  }
  const n = (c: any) => {
    const cur = nonces.get(c.account.address)!;
    nonces.set(c.account.address, cur + 1);
    return { nonce: cur, account: c.account };
  };
  const settle = async (label: string, hash: Hex) => {
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${label} reverted`);
    console.log(`  ${label} (block ${r.blockNumber}, gas ${r.gasUsed})`);
  };

  // ---- 1. the maker wraps real bonds ------------------------------------
  const bondBalance = (await publicClient.readContract({
    address: d.bondToken,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [maker.account.address],
  })) as bigint;
  console.log(`1. maker holds ${formatUnits(bondBalance, 18)} ACME30 (real ERC-3643 token)`);
  if (bondBalance < WRAP_AMOUNT) throw new Error("maker has too few bonds to wrap");

  await settle(
    "approve",
    await publicClient.simulateContract({
      address: d.bondToken,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [d.sharesWrapper, WRAP_AMOUNT],
      account: maker.account,
    }).then(() => maker.writeContract({
      address: d.bondToken,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [d.sharesWrapper, WRAP_AMOUNT],
      ...n(maker),
    })),
  );

  await settle("wrap", await wrapper.write.wrap([WRAP_AMOUNT], n(maker)));
  console.log(`   wrapped ${formatUnits(WRAP_AMOUNT, 18)} into a confidential balance\n`);

  const handle = (await wrapper.read.balanceHandle([maker.account.address])) as Hex;
  console.log(`   register handle ${handle}\n`);

  // ---- 2. the auditor is refused ----------------------------------------
  const hcAuditor = await createViemHandleClient(roleWalletClient("AUDITOR", chainId) as any);

  const grantedBefore = (await publicClient.readContract({
    address: NOX,
    abi: IS_VIEWER_ABI,
    functionName: "isViewer",
    args: [handle, auditorAddr],
  })) as boolean;

  console.log(`2. auditor attempts to read the register BEFORE any grant`);
  console.log(`   on-chain isViewer = ${grantedBefore}`);

  // Wait until the handle is actually indexed before attempting, so the refusal
  // is a genuine "not a viewer" rather than "handle not seen yet". The two are
  // different claims and only the first one proves anything about access.
  const indexDeadline = Date.now() + TIMEOUT_MS;
  let denial = "";
  while (Date.now() < indexDeadline) {
    try {
      const r = await hcAuditor.decrypt(handle);
      console.log(`   UNEXPECTED: auditor read ${r.value} without a grant`);
      process.exitCode = 1;
      return;
    } catch (e: any) {
      denial = e.message ?? String(e);
      if (/not a viewer|access_denied/i.test(denial)) break; // a real denial
      await new Promise((r) => setTimeout(r, POLL_MS)); // still being indexed
    }
  }
  console.log(`   DENIED: ${denial.slice(0, 110)}`);

  // ---- 3. the issuer discloses ------------------------------------------
  console.log(`\n3. issuer grants the auditor access to THIS holder's balance`);
  await settle(
    "grantRegisterAccess",
    await wrapper.write.grantRegisterAccess([maker.account.address, auditorAddr], n(issuer)),
  );

  // ---- 4. the auditor reads it ------------------------------------------
  console.log(`\n4. auditor reads the register`);
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const r = await hcAuditor.decrypt(handle);
      console.log(`   DECRYPTED: ${formatUnits(BigInt(r.value as bigint), 18)} ACME30`);
      console.log(`\nDisclosed by the issuer, on request, for one holder.`);
      console.log(`This grant is PERMANENT — Nox has no revocation primitive. What it does`);
      console.log(`NOT do is follow the holder: the next transfer mints a fresh handle that`);
      console.log(`the auditor cannot read. Rotation, not revocation.`);
      return;
    } catch (e: any) {
      if (!isTransient(e) && !/not a viewer|access_denied/i.test(e.message ?? "")) {
        console.log(`   failed: ${e.message}`);
        process.exitCode = 1;
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
  console.log(`   timed out waiting for the gateway to serve the grant`);
  process.exitCode = 1;
}

main().catch((e: any) => {
  console.error(`\nfailed: ${e.details ?? e.shortMessage ?? e.message}`);
  process.exitCode = 1;
});
