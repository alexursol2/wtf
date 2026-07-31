/**
 * Posts resting asks for the two newer instruments, so their books are not
 * empty.
 *
 * The instrument itself cannot be recorded on-chain — `DeferralVenue.Order` has
 * no such field — so this script writes the mapping it KNOWS to be true (it
 * posted the orders, so it knows what they are for) into the deployment record.
 * The frontend ships that map, which is why these orders show under the right
 * pair in any browser, unlike ones posted through the UI which are only tagged
 * locally.
 *
 *   npx hardhat run scripts/seed-instrument-orders.ts --network sepolia
 */
import { network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { createViemHandleClient } from "@iexec-nox/handle";
import { loadEnv, roleWalletClient } from "../lib/env.js";
import type { Hex } from "viem";

/** Sizes and prices chosen to look like a real book: a few levels either side. */
const BOOK: Record<string, { qty: bigint; price: bigint }[]> = {
  "AAPL.rwa": [
    { qty: 1_200n, price: 2_284_000n }, // 228.4000
    { qty: 800n, price: 2_291_500n }, // 229.1500
    { qty: 2_500n, price: 2_279_000n }, // 227.9000
  ],
  "TSLA.rwa": [
    { qty: 600n, price: 4_121_500n }, // 412.1500
    { qty: 1_500n, price: 4_138_000n }, // 413.8000
  ],
};

/** Escrow to self-declare before posting. depositShares takes no real custody. */
const SHARE_FUNDING = 100_000n;
const EXPIRY_DAYS = 3650n; // effectively GTC for a demo book

async function main() {
  loadEnv();
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const [, maker] = await viem.getWalletClients();
  if (!maker) throw new Error("need PRIVATE_KEY_MAKER");

  const record = path.join(import.meta.dirname, "..", "..", "deployments", "venue.sepolia.json");
  const d = JSON.parse(fs.readFileSync(record, "utf8"));
  if (d.chainId !== chainId) throw new Error(`record is chain ${d.chainId}, connected to ${chainId}`);

  const venue = await viem.getContractAt("DeferralVenue", d.venue);
  const hc = await createViemHandleClient(roleWalletClient("MAKER", chainId) as any);

  console.log(`venue ${d.venue}`);
  console.log(`maker ${maker.account.address}\n`);

  let nonce = await publicClient.getTransactionCount({
    address: maker.account.address,
    blockTag: "pending",
  });
  const n = () => ({ nonce: nonce++, account: maker.account });

  const send = async (label: string, hash: Hex) => {
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${label} reverted`);
    console.log(`  ${label}  gas ${r.gasUsed}`);
    return r;
  };

  const enc = async (v: bigint) => {
    const { handle, handleProof } = await hc.encryptInput(v, "uint256", d.venue as Hex);
    return { handle: handle as Hex, proof: handleProof as Hex };
  };

  // One deposit covers every ask below; escrow is self-declared, so a single
  // credit is enough for the whole seeding run.
  console.log("funding share escrow…");
  const dep = await enc(SHARE_FUNDING);
  await send("depositShares", await venue.write.depositShares([dep.handle, dep.proof], n()));

  const tags: Record<string, string> = d.orderInstruments ?? {};
  const latest = await publicClient.getBlock();
  const expiry = BigInt(latest.timestamp) + EXPIRY_DAYS * 86_400n;

  for (const [symbol, levels] of Object.entries(BOOK)) {
    console.log(`\n${symbol}`);
    for (const { qty, price } of levels) {
      const q = await enc(qty);
      const p = await enc(price);

      // ordersCount BEFORE the push is the id this order will take.
      const id = (await venue.read.ordersCount()) as bigint;

      await send(
        `postAsk ${qty} @ ${price}  -> order #${id}`,
        await venue.write.postAsk([q.handle, p.handle, q.proof, p.proof, expiry], n()),
      );
      tags[id.toString()] = symbol;
    }
  }

  d.orderInstruments = tags;
  d.seededAt = new Date().toISOString();
  fs.writeFileSync(record, JSON.stringify(d, null, 2));

  console.log(`\nwrote ${record}`);
  console.log("\norderInstruments:");
  console.log(JSON.stringify(tags, null, 2));
}

main().catch((e: any) => {
  console.error(`\nfailed: ${e.details ?? e.shortMessage ?? e.message}`);
  process.exitCode = 1;
});
