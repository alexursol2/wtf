/**
 * Publishes the deferred volume for a reported fill, once the deferral has
 * elapsed — the second half of the disclosure regime.
 *
 * Before this runs, the price is public and the volume is not. That gap is the
 * entire thesis of the project, so this script prints the disclosure state on
 * both sides of the call rather than just performing it.
 *
 *   FILL_ID=0 npx hardhat run scripts/publish-volume.ts --network sepolia
 */
import { network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { createViemHandleClient } from "@iexec-nox/handle";
import { loadEnv, roleWalletClient } from "../lib/env.js";

async function main() {
  loadEnv();
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const [, maker] = await viem.getWalletClients();

  const fillId = BigInt(process.env.FILL_ID ?? "0");
  const record = path.join(import.meta.dirname, "..", "..", "deployments", "venue.sepolia.json");
  const d = JSON.parse(fs.readFileSync(record, "utf8"));
  if (d.chainId !== chainId) throw new Error(`record is chain ${d.chainId}, connected to ${chainId}`);

  const venue = await viem.getContractAt("DeferralVenue", d.venue);
  const f = (await venue.read.fills([fillId])) as any[];
  const [fMaker, , qtyHandle, priceHandle, bucket, deferredUntil, reported, volumePublished] = f;

  const now = BigInt((await publicClient.getBlock()).timestamp);

  console.log(`\nfill #${fillId} on ${d.venue}`);
  console.log(`  bucket            ${Number(bucket) === 1 ? "LargeInScale" : "Standard"}`);
  console.log(`  reported          ${reported}`);
  console.log(`  volumePublished   ${volumePublished}`);
  console.log(`  deferredUntil     ${deferredUntil}  (now ${now})`);

  if (!reported) throw new Error("not reported yet — the maker must call reportTrade first");
  if (volumePublished) {
    console.log(`\nalready published.`);
    return;
  }
  if (now < deferredUntil) {
    const left = Number(deferredUntil - now);
    console.log(`\nstill deferred for ${left}s. This is the regime working, not an error.`);
    console.log(`Re-run in ${left}s.`);
    return;
  }

  // Read the disclosure state as the PUBLIC sees it, before and after.
  const hc = await createViemHandleClient(roleWalletClient("MAKER", chainId) as any);

  const priceBefore = await hc.publicDecrypt(priceHandle).catch(() => null);
  const volumeBefore = await hc.publicDecrypt(qtyHandle).catch(() => null);
  console.log(`\nbefore publishVolume — what ANY member of the public can read:`);
  console.log(`  price   ${priceBefore ? priceBefore.value : "PRIVATE"}`);
  console.log(`  volume  ${volumeBefore ? volumeBefore.value : "PRIVATE"}   <- withheld by the deferral`);

  if (fMaker.toLowerCase() !== maker.account.address.toLowerCase()) {
    console.log(`\nNOTE: publishVolume is callable by anyone once the deferral elapses;`);
    console.log(`only reportTrade is maker-only. Sending as ${maker.account.address}.`);
  }

  const nonce = await publicClient.getTransactionCount({
    address: maker.account.address,
    blockTag: "pending",
  });
  const hash = await venue.write.publishVolume([fillId], { nonce, account: maker.account });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`\npublishVolume mined in block ${r.blockNumber} (gas ${r.gasUsed})`);

  // The ACL is updated on-chain the moment the transaction lands, but the
  // gateway reads it through an indexer that trails the head by a block or two.
  // So a publicDecrypt fired immediately after the receipt can still report the
  // value as private. Poll rather than concluding from one attempt — and confirm
  // against the chain, which is authoritative.
  const onChainPublic = await publicClient.readContract({
    address: (await import("../lib/nox-local.js")).NOX_COMPUTE_LOCAL as any,
    abi: [
      {
        name: "isPubliclyDecryptable",
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "bytes32" }],
        outputs: [{ type: "bool" }],
      },
    ],
    functionName: "isPubliclyDecryptable",
    args: [qtyHandle],
  }).catch(() => null);

  let volumeAfter: any = null;
  for (let attempt = 1; attempt <= 10 && !volumeAfter; attempt++) {
    volumeAfter = await hc.publicDecrypt(qtyHandle).catch(() => null);
    if (!volumeAfter) {
      if (attempt === 1) console.log(`\nwaiting for the indexer to catch up...`);
      await new Promise((r) => setTimeout(r, 6_000));
    }
  }

  console.log(`\nafter publishVolume:`);
  console.log(`  price   ${priceBefore ? priceBefore.value : "?"}`);
  console.log(`  volume  ${volumeAfter ? volumeAfter.value : "not yet served by the gateway"}`);
  if (onChainPublic !== null) console.log(`  on-chain isPubliclyDecryptable = ${onChainPublic}`);

  if (volumeAfter) {
    console.log(`\nThe full print is now public: ${volumeAfter.value} @ ${priceBefore?.value}.`);
    console.log(`Both halves of the regime, in the right order, on a real chain.`);
  } else if (onChainPublic) {
    console.log(`\nThe on-chain ACL is public, so publication succeeded; the gateway is`);
    console.log(`simply behind. Re-run to read the value.`);
  } else {
    process.exitCode = 1;
  }
}

main().catch((e: any) => {
  console.error(`\nfailed: ${e.details ?? e.shortMessage ?? e.message}`);
  process.exitCode = 1;
});
