/**
 * Drives one full trade through the venue and narrates what is and is not
 * visible at each step. This is the sequence the demo video follows.
 *
 *   post  →  fill  →  reportTrade (price prints)  →  publishVolume (volume prints)
 *
 * The disclosure state printed at each step is read from NoxCompute itself
 * (isPubliclyDecryptable), not asserted from the source — so the output is
 * evidence, not narration.
 *
 * On a local chain this bootstraps NoxCompute and deploys everything fresh.
 * Against testnet, pass VENUE=0x... to drive an existing deployment.
 *
 *   npx hardhat run scripts/demo-trade.ts
 */
import { network } from "hardhat";
import { bootstrapNoxCompute, makeInputProof, buildHandle, NOX_COMPUTE_LOCAL, TEEType } from "../lib/nox-local.js";
import type { Hex } from "viem";

/** Instrument index into the frontend's INSTRUMENTS list. 0 = ACME30. */
const INSTRUMENT = 0;

const PRICE_SCALE = 10_000n;

async function main() {
  const { viem, provider, networkHelpers } = await network.connect({ network: "hardhat" });
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const [deployer, maker, taker, auditor] = await viem.getWalletClients();

  const { gateway, abi: noxAbi } = await bootstrapNoxCompute(viem, provider);

  const registry = await viem.deployContract("MockIdentityRegistry");
  for (const who of [deployer, maker, taker, auditor]) {
    await registry.write.setVerified([who.account.address, true]);
  }
  const venue = await viem.deployContract("DeferralVenue", [registry.address, auditor.account.address]);

  const isPublic = (handle: Hex) =>
    publicClient.readContract({
      address: NOX_COMPUTE_LOCAL,
      abi: noxAbi,
      functionName: "isPubliclyDecryptable",
      args: [handle],
    }) as Promise<boolean>;

  let salt = 900;
  async function enc(owner: Hex) {
    const handle = buildHandle(chainId, TEEType.Uint256, salt++);
    const proof = await makeInputProof({ gateway, chainId, handle, owner, app: venue.address });
    return { handle, proof };
  }

  const line = (s: string) => console.log(s);
  const yesno = (b: boolean) => (b ? "PUBLIC" : "private");

  line("");
  line("  Confidential RFQ venue — one trade, end to end");
  line("  price convention: notional = qty x price / " + PRICE_SCALE);
  line("");

  // ---- escrow ----
  for (const who of [maker, taker]) {
    const c = await enc(who.account.address);
    await venue.write.depositCash([c.handle, c.proof], { account: who.account });
  }
  const ms = await enc(maker.account.address);
  await venue.write.depositShares([ms.handle, ms.proof], { account: maker.account });
  line("  1. both sides escrowed. Both legs are encrypted — a public cash leg");
  line("     would leak the price and void the design.");

  // ---- post ----
  const q = await enc(maker.account.address);
  const p = await enc(maker.account.address);
  await venue.write.postAsk([INSTRUMENT, q.handle, p.handle, q.proof, p.proof], {
    account: maker.account,
  });
  const order = (await venue.read.orders([0n])) as unknown as any[];
  line(`  2. ask posted. quantity and price are ciphertext handles.`);
  line(`     order price:            ${yesno(await isPublic(order[2]))}`);

  // ---- fill ----
  const bid = await enc(taker.account.address);
  const want = await enc(taker.account.address);
  await venue.write.fill([0n, bid.handle, want.handle, bid.proof, want.proof, 1], {
    account: taker.account,
  });
  const fill = (await venue.read.fills([0n])) as unknown as any[];
  line("  3. filled, branchlessly. Nobody — not the operator, not iExec, not the");
  line("     TEE Runner — learns whether the order crossed. Settlement is a");
  line("     chain of selects on an unreadable ebool.");
  line(`     fill price:             ${yesno(await isPublic(fill[3]))}`);
  line(`     fill volume:            ${yesno(await isPublic(fill[2]))}`);

  // ---- report ----
  await venue.write.reportTrade([0n], { account: maker.account });
  const afterReport = (await venue.read.fills([0n])) as unknown as any[];
  line("  4. the MAKER reports the trade — the reporting entity does it, as in");
  line("     the real regime. Price prints. Volume does not.");
  line(`     fill price:             ${yesno(await isPublic(afterReport[3]))}`);
  line(`     fill volume:            ${yesno(await isPublic(afterReport[2]))}`);
  line(`     resting order price:    ${yesno(await isPublic(((await venue.read.orders([0n])) as unknown as any[])[2]))}  <- snapshot kept the live handle private`);

  // ---- deferral ----
  const deferral = await venue.read.LIS_DEFERRAL();
  line(`  5. declared large-in-scale, so volume is deferred ${deferral}s`);
  line("     (demo value; the real regime defers to end of the following quarter).");
  try {
    await venue.write.publishVolume([0n], { account: maker.account });
    line("     UNEXPECTED: volume published before the deferral elapsed");
  } catch {
    line("     publishVolume refused while deferred — as designed.");
  }

  await networkHelpers.time.increase(Number(deferral) + 1);
  await venue.write.publishVolume([0n], { account: maker.account });
  const final = (await venue.read.fills([0n])) as unknown as any[];
  line("  6. deferral elapsed. Volume prints.");
  line(`     fill volume:            ${yesno(await isPublic(final[2]))}`);
  line("");
  line("  The regulator held the volume handle from block one (auditor viewer");
  line("  grant at fill), so an unreported trade is detectable — not preventable.");
  line("");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
