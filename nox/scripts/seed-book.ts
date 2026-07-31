/**
 * Builds a real two-sided book on a freshly deployed venue.
 *
 * A redeploy starts empty — orders and fills live in the venue's own arrays —
 * so this stands the demo back up: bids and asks in every instrument, then a
 * trade on each side of the book so both paths have printed at least once.
 *
 * The instrument is now a PLAINTEXT field on the order, so nothing has to be
 * recorded off-chain any more. The frontend reads it directly.
 *
 *   npx hardhat run scripts/seed-book.ts --network sepolia
 */
import { network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { createViemHandleClient } from "@iexec-nox/handle";
import { loadEnv, roleWalletClient } from "../lib/env.js";
import type { Hex } from "viem";

/** Index into the frontend's INSTRUMENTS array. */
const ACME30 = 0;
const AAPL = 1;
const TSLA = 2;

const ASKS = [
  { inst: ACME30, qty: 1_000n, price: 987_500n },
  { inst: ACME30, qty: 2_500n, price: 989_000n },
  { inst: AAPL, qty: 1_200n, price: 2_284_000n },
  { inst: AAPL, qty: 800n, price: 2_291_500n },
  { inst: TSLA, qty: 600n, price: 4_121_500n },
];

const BIDS = [
  { inst: ACME30, qty: 1_500n, price: 986_000n },
  { inst: AAPL, qty: 900n, price: 2_278_000n },
  { inst: TSLA, qty: 400n, price: 4_110_000n },
];

const SHARE_FUNDING = 200_000n;
const CASH_FUNDING = 20_000_000_000n;
const EXPIRY_DAYS = 3650n;
const STANDARD = 0; // publishes immediately, so the demo tape fills at once

async function main() {
  loadEnv();
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const [, maker, taker] = await viem.getWalletClients();
  if (!maker || !taker) throw new Error("need PRIVATE_KEY_MAKER and PRIVATE_KEY_TAKER");

  const recordPath = path.join(import.meta.dirname, "..", "..", "deployments", "venue.sepolia.json");
  const d = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  const venue = await viem.getContractAt("DeferralVenue", d.venue);
  console.log(`venue ${d.venue}\n`);

  const hcMaker = await createViemHandleClient(roleWalletClient("MAKER", chainId) as any);
  const hcTaker = await createViemHandleClient(roleWalletClient("TAKER", chainId) as any);

  const nonces = new Map<string, number>();
  for (const c of [maker, taker]) {
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

  const send = async (label: string, hash: Hex) => {
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${label} reverted`);
    console.log(`  ${label}`);
    return r;
  };

  const enc = async (hc: any, v: bigint) => {
    const { handle, handleProof } = await hc.encryptInput(v, "uint256", d.venue as Hex);
    return { handle: handle as Hex, proof: handleProof as Hex };
  };

  // ---- escrow. Both parties need both legs: each takes one side of the book.
  console.log("funding escrow…");
  const ms = await enc(hcMaker, SHARE_FUNDING);
  await send("maker depositShares", await venue.write.depositShares([ms.handle, ms.proof], n(maker)));
  const mc = await enc(hcMaker, CASH_FUNDING);
  await send("maker depositCash", await venue.write.depositCash([mc.handle, mc.proof], n(maker)));
  const ts = await enc(hcTaker, SHARE_FUNDING);
  await send("taker depositShares", await venue.write.depositShares([ts.handle, ts.proof], n(taker)));
  const tc = await enc(hcTaker, CASH_FUNDING);
  await send("taker depositCash", await venue.write.depositCash([tc.handle, tc.proof], n(taker)));

  const latest = await publicClient.getBlock();
  const expiry = BigInt(latest.timestamp) + EXPIRY_DAYS * 86_400n;

  // ---- asks from the maker
  console.log("\nasks (maker sells)…");
  const askIds: bigint[] = [];
  for (const a of ASKS) {
    const q = await enc(hcMaker, a.qty);
    const p = await enc(hcMaker, a.price);
    const id = (await venue.read.ordersCount()) as bigint;
    await send(
      `postAsk inst ${a.inst}  ${a.qty} @ ${a.price}  -> #${id}`,
      await venue.write.postAsk([a.inst, q.handle, p.handle, q.proof, p.proof, expiry], n(maker)),
    );
    askIds.push(id);
  }

  // ---- bids from the taker
  console.log("\nbids (taker buys)…");
  const bidIds: bigint[] = [];
  for (const b of BIDS) {
    const q = await enc(hcTaker, b.qty);
    const p = await enc(hcTaker, b.price);
    const id = (await venue.read.ordersCount()) as bigint;
    await send(
      `postBid inst ${b.inst}  ${b.qty} @ ${b.price}  -> #${id}`,
      await venue.write.postBid([b.inst, q.handle, p.handle, q.proof, p.proof, expiry], n(taker)),
    );
    bidIds.push(id);
  }

  // ---- one trade on each side, so both paths have printed
  console.log("\ntrades…");

  // taker lifts an ask
  {
    const bid = await enc(hcTaker, 990_000n);
    const q = await enc(hcTaker, 400n);
    const fillId = (await venue.read.fillsCount()) as bigint;
    await send(
      `fill ask #${askIds[0]}  -> trade #${fillId}`,
      await venue.write.fill([askIds[0], bid.handle, q.handle, bid.proof, q.proof, STANDARD], n(taker)),
    );
    await send(`reportTrade #${fillId}`, await venue.write.reportTrade([fillId], n(maker)));
    await send(`publishVolume #${fillId}`, await venue.write.publishVolume([fillId], n(maker)));
  }

  // maker sells into a bid — the path that only exists now
  {
    const ask = await enc(hcMaker, 2_270_000n);
    const q = await enc(hcMaker, 300n);
    const fillId = (await venue.read.fillsCount()) as bigint;
    await send(
      `hit bid #${bidIds[1]}  -> trade #${fillId}`,
      await venue.write.hit([bidIds[1], ask.handle, q.handle, ask.proof, q.proof, STANDARD], n(maker)),
    );
    // The bid's MAKER is the reporting entity, and that is the taker here.
    await send(`reportTrade #${fillId}`, await venue.write.reportTrade([fillId], n(taker)));
    await send(`publishVolume #${fillId}`, await venue.write.publishVolume([fillId], n(taker)));
  }

  console.log(`\norders ${await venue.read.ordersCount()}   fills ${await venue.read.fillsCount()}`);
}

main().catch((e: any) => {
  console.error(`\nfailed: ${e.details ?? e.shortMessage ?? e.message}`);
  process.exitCode = 1;
});
