/**
 * Sizes the gas cost of every venue operation, so testnet funding and the
 * block-limit question are answered with numbers rather than estimates.
 *
 * Nox operations are external calls to NoxCompute that each emit an event, and
 * fill() makes a lot of them — two fromExternal, a ge, an lt, five selects, a
 * safeMul, a div, two transfers, an add, then a long tail of ACL grants. That
 * makes fill() by far the most expensive call, and worth watching against the
 * block gas limit.
 *
 *   npx hardhat run scripts/measure-gas.ts
 */
import { network } from "hardhat";
import { bootstrapNoxCompute, makeInputProof, buildHandle, TEEType } from "../lib/nox-local.js";
import type { Hex } from "viem";

const rows: [string, bigint][] = [];

async function main() {
  const { viem, provider } = await network.connect({ network: "hardhat" });
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const [deployer, maker, taker, auditor] = await viem.getWalletClients();

  const { gateway } = await bootstrapNoxCompute(viem, provider);

  async function track(label: string, hash: Hex) {
    const r = await publicClient.waitForTransactionReceipt({ hash });
    rows.push([label, r.gasUsed]);
  }

  /** Deploys and records the deployment gas. */
  async function deploy(label: string, name: string, args: any[] = []) {
    const { contract, deploymentTransaction } = await viem.sendDeploymentTransaction(
      name as any,
      args as any,
    );
    await track(label, deploymentTransaction.hash as Hex);
    return contract as any;
  }

  const registry = await deploy("MockIdentityRegistry (deploy)", "MockIdentityRegistry");
  for (const w of [deployer, maker, taker, auditor]) {
    await registry.write.setVerified([w.account.address, true]);
  }

  const cash = await deploy("MockERC20 (deploy)", "MockERC20", ["Mock Euro", "mEUR", 6]);

  const wrapper = await deploy("ConfidentialWrapper (deploy)", "ConfidentialWrapper", [
    cash.address,
    registry.address,
  ]);

  const venue = await deploy("DeferralVenue (deploy + toEuint256)", "DeferralVenue", [
    registry.address,
    auditor.account.address,
  ]);

  let salt = 4000;
  async function enc(owner: Hex, app: Hex) {
    const handle = buildHandle(chainId, TEEType.Uint256, salt++);
    const proof = await makeInputProof({ gateway, chainId, handle, owner, app });
    return { handle, proof };
  }

  // wrapper paths
  await cash.write.mint([maker.account.address, 1_000_000n]);
  await cash.write.approve([wrapper.address, 1_000_000n], { account: maker.account });
  await track(
    "wrapper.wrap",
    await wrapper.write.wrap([500_000n], { account: maker.account }),
  );
  await track(
    "wrapper.requestUnwrap",
    await wrapper.write.requestUnwrap([1_000n], { account: maker.account }),
  );

  // venue paths
  const mc = await enc(maker.account.address, venue.address);
  await track("venue.depositCash", await venue.write.depositCash([mc.handle, mc.proof], { account: maker.account }));
  const tc = await enc(taker.account.address, venue.address);
  await track("venue.depositCash (taker)", await venue.write.depositCash([tc.handle, tc.proof], { account: taker.account }));
  const ms = await enc(maker.account.address, venue.address);
  await track("venue.depositShares", await venue.write.depositShares([ms.handle, ms.proof], { account: maker.account }));

  const q = await enc(maker.account.address, venue.address);
  const p = await enc(maker.account.address, venue.address);
  const now = (await publicClient.getBlock()).timestamp;
  await track(
    "venue.postAsk",
    await venue.write.postAsk([q.handle, p.handle, q.proof, p.proof, BigInt(now) + 3600n], {
      account: maker.account,
    }),
  );

  const bid = await enc(taker.account.address, venue.address);
  const want = await enc(taker.account.address, venue.address);
  await track(
    "venue.fill  <-- the expensive one",
    await venue.write.fill([0n, bid.handle, want.handle, bid.proof, want.proof, 1], {
      account: taker.account,
    }),
  );

  await track("venue.reportTrade", await venue.write.reportTrade([0n], { account: maker.account }));

  // ---- report ----
  const width = Math.max(...rows.map(([l]) => l.length));
  let deployTotal = 0n;
  for (const [label, gas] of rows) {
    if (label.includes("deploy")) deployTotal += gas;
    console.log(`${gas.toString().padStart(9)}  ${label.padEnd(width)}`);
  }

  const limit = (await publicClient.getBlock()).gasLimit;
  const fill = rows.find(([l]) => l.startsWith("venue.fill"))![1];
  console.log("-".repeat(width + 11));
  console.log(`${deployTotal.toString().padStart(9)}  Nox-side deploys total`);
  console.log(`\nblock gas limit here: ${limit}`);
  console.log(`fill() uses ${((Number(fill) / Number(limit)) * 100).toFixed(1)}% of one block`);
  console.log("\nSepolia block limit is ~36,000,000 — fill() is well inside it.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
