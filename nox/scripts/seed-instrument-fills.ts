/**
 * Executes and reports one trade in each of the newer instruments, so their
 * tapes are not blank.
 *
 * Without this the AAPL and TSLA books have resting offers but nothing has ever
 * traded, so there is no print, no last price and nothing on the ticker — the
 * instruments look deployed but dead.
 *
 * Reports immediately with the STANDARD bucket so the volume can be published
 * without waiting out the deferral; the LIS path is already demonstrated by the
 * ACME30 history.
 *
 *   npx hardhat run scripts/seed-instrument-fills.ts --network sepolia
 */
import { network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { createViemHandleClient } from "@iexec-nox/handle";
import { loadEnv, roleWalletClient } from "../lib/env.js";
import type { Hex } from "viem";

/** orderId -> what the taker lifts. Bids clear the asks seeded earlier. */
const TRADES = [
  { orderId: 6n, symbol: "AAPL.rwa", bid: 2_300_000n, qty: 400n },
  { orderId: 9n, symbol: "TSLA.rwa", bid: 4_150_000n, qty: 250n },
];

const CASH_FUNDING = 5_000_000_000n;
const BUCKET_STANDARD = 0;

async function main() {
  loadEnv();
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const [, maker, taker] = await viem.getWalletClients();
  if (!maker || !taker) throw new Error("need PRIVATE_KEY_MAKER and PRIVATE_KEY_TAKER");

  const record = path.join(import.meta.dirname, "..", "..", "deployments", "venue.sepolia.json");
  const d = JSON.parse(fs.readFileSync(record, "utf8"));
  const venue = await viem.getContractAt("DeferralVenue", d.venue);

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
    console.log(`  ${label}  gas ${r.gasUsed}`);
    return r;
  };

  const enc = async (v: bigint) => {
    const { handle, handleProof } = await hcTaker.encryptInput(v, "uint256", d.venue as Hex);
    return { handle: handle as Hex, proof: handleProof as Hex };
  };

  console.log("funding taker cash escrow…");
  const c = await enc(CASH_FUNDING);
  await send("depositCash", await venue.write.depositCash([c.handle, c.proof], n(taker)));

  const fillTags: Record<string, string> = d.fillInstruments ?? {};

  for (const t of TRADES) {
    console.log(`\n${t.symbol} — lifting order #${t.orderId}`);
    const bid = await enc(t.bid);
    const qty = await enc(t.qty);

    const fillId = (await venue.read.fillsCount()) as bigint;

    await send(
      `fill ${t.qty} @ bid ${t.bid} -> fill #${fillId}`,
      await venue.write.fill(
        [t.orderId, bid.handle, qty.handle, bid.proof, qty.proof, BUCKET_STANDARD],
        n(taker),
      ),
    );
    fillTags[fillId.toString()] = t.symbol;

    // The maker is the reporting entity — this is what puts the price on tape.
    await send(`reportTrade #${fillId}`, await venue.write.reportTrade([fillId], n(maker)));

    // Standard bucket defers to `now`, so the volume can be published at once.
    await send(`publishVolume #${fillId}`, await venue.write.publishVolume([fillId], n(maker)));
  }

  d.fillInstruments = fillTags;
  fs.writeFileSync(record, JSON.stringify(d, null, 2));
  console.log(`\nwrote ${record}`);
  console.log("\nfillInstruments:");
  console.log(JSON.stringify(fillTags, null, 2));
}

main().catch((e: any) => {
  console.error(`\nfailed: ${e.details ?? e.shortMessage ?? e.message}`);
  process.exitCode = 1;
});
