/**
 * Builds a real two-sided book on a freshly deployed venue.
 *
 * A redeploy starts empty — orders and fills live in the venue's own arrays —
 * so this stands the demo back up: a LADDER of bids and asks in every
 * instrument, from both accounts, and then a trade on each side of each book so
 * every instrument has printed and has a last price.
 *
 * Three properties are deliberate:
 *
 *  - Both accounts quote BOTH SIDES. A book where one address holds every ask
 *    and the other every bid is not a book, it is two queues, and whichever
 *    account you connect as can only ever see one of them (the venue rejects a
 *    self-fill, so your own orders are not tradable by you).
 *
 *  - The levels sit INSIDE the 2% collar the frontend sends for a market order.
 *    A level further out than that is unreachable at market, which looks like a
 *    broken button rather than a working price guard.
 *
 *  - The seeded trades are PARTIAL, and their orders are reopened afterwards.
 *    A partially filled order resting with a remainder is the case the UI is
 *    built around, so the demo should contain one from the first minute.
 *
 * The instrument is a PLAINTEXT field on the order, so nothing has to be
 * recorded off-chain. The frontend reads it directly.
 *
 *   npx hardhat run scripts/seed-book.ts --network sepolia
 */
import { network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { createViemHandleClient } from "@iexec-nox/handle";
import { loadEnv, roleWalletClient } from "../lib/env.js";
import type { Hex } from "viem";

type Who = "maker" | "taker";

interface Level {
  qty: bigint;
  price: bigint;
  from: Who;
}

interface Book {
  /** Index into the frontend's INSTRUMENTS array. Order is load-bearing. */
  inst: number;
  symbol: string;
  /** Offers, best (cheapest) first. */
  asks: Level[];
  /** Bids, best (dearest) first. */
  bids: Level[];
  /** Sizes for the two seeded trades — smaller than the level, so both rest on. */
  liftQty: bigint;
  sellQty: bigint;
}

/**
 * Prices are scaled by PRICE_SCALE (1e4) and sit within ~1% of the indicative
 * level in `frontend/src/reference.ts`, which keeps every level reachable by a
 * market order inside its collar.
 */
const BOOKS: Book[] = [
  {
    inst: 0,
    symbol: 'ACME30',
    asks: [
      { qty: 8n, price: 252_000n, from: 'maker' },   // $25.20
      { qty: 12n, price: 254_000n, from: 'taker' },  // $25.40
      { qty: 20n, price: 256_000n, from: 'maker' },  // $25.60
    ],
    bids: [
      { qty: 10n, price: 248_000n, from: 'taker' },  // $24.80
      { qty: 15n, price: 246_000n, from: 'maker' },  // $24.60
      { qty: 25n, price: 244_000n, from: 'taker' },  // $24.40
    ],
    liftQty: 2n,
    sellQty: 3n,
  },
  {
    inst: 1,
    symbol: 'AAPL.rwa',
    asks: [
      { qty: 6n, price: 504_000n, from: 'maker' },   // $50.40
      { qty: 10n, price: 508_000n, from: 'taker' },  // $50.80
      { qty: 16n, price: 512_000n, from: 'maker' },  // $51.20
    ],
    bids: [
      { qty: 8n, price: 496_000n, from: 'taker' },   // $49.60
      { qty: 12n, price: 492_000n, from: 'maker' },  // $49.20
      { qty: 20n, price: 488_000n, from: 'taker' },  // $48.80
    ],
    liftQty: 2n,
    sellQty: 2n,
  },
  {
    inst: 2,
    symbol: 'TSLA.rwa',
    asks: [
      { qty: 4n, price: 1_008_000n, from: 'maker' },  // $100.80
      { qty: 8n, price: 1_016_000n, from: 'taker' },  // $101.60
      { qty: 12n, price: 1_024_000n, from: 'maker' }, // $102.40
    ],
    bids: [
      { qty: 5n, price: 992_000n, from: 'taker' },    // $99.20
      { qty: 9n, price: 984_000n, from: 'maker' },    // $98.40
      { qty: 14n, price: 976_000n, from: 'taker' },   // $97.60
    ],
    liftQty: 1n,
    sellQty: 2n,
  },
];

/**
 * Escrow to self-declare before posting.
 *
 * Generous on purpose. Escrow is branchless: an underfunded order escrows zero
 * and then settles for zero, silently, because a revert would leak the
 * shortfall — so an under-funded seeding run produces a book that looks right
 * and trades for nothing.
 */
const SHARE_FUNDING = 2_000n;
const CASH_FUNDING = 100_000n;

/** Publishes immediately, so the demo tape fills without waiting out an hour. */
const STANDARD = 0;

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

  const clients: Record<Who, any> = { maker, taker };
  const handles: Record<Who, any> = {
    maker: await createViemHandleClient(roleWalletClient("MAKER", chainId) as any),
    taker: await createViemHandleClient(roleWalletClient("TAKER", chainId) as any),
  };

  // Nonces are tracked locally: every call below is sent without waiting for the
  // previous one from the SAME account to be mined, and a hosted RPC's pending
  // count lags enough to hand out the same nonce twice.
  const nonces = new Map<string, number>();
  for (const c of [maker, taker]) {
    nonces.set(
      c.account.address,
      await publicClient.getTransactionCount({ address: c.account.address, blockTag: "pending" }),
    );
  }
  const n = (who: Who) => {
    const c = clients[who];
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

  const enc = async (who: Who, v: bigint) => {
    const { handle, handleProof } = await handles[who].encryptInput(v, "uint256", d.venue as Hex);
    return { handle: handle as Hex, proof: handleProof as Hex };
  };

  // ---- escrow. Both parties need both legs: each takes both sides of the book.
  console.log("funding escrow…");
  for (const who of ["maker", "taker"] as const) {
    const s = await enc(who, SHARE_FUNDING);
    await send(`${who} depositShares`, await venue.write.depositShares([s.handle, s.proof], n(who)));
    const c = await enc(who, CASH_FUNDING);
    await send(`${who} depositCash`, await venue.write.depositCash([c.handle, c.proof], n(who)));
  }

  // ---- the ladders
  const askIds = new Map<number, { id: bigint; from: Who }[]>();
  const bidIds = new Map<number, { id: bigint; from: Who }[]>();

  for (const b of BOOKS) {
    console.log(`\n${b.symbol} — asks…`);
    const asks: { id: bigint; from: Who }[] = [];
    for (const a of b.asks) {
      const q = await enc(a.from, a.qty);
      const p = await enc(a.from, a.price);
      const id = (await venue.read.ordersCount()) as bigint;
      await send(
        `postAsk ${a.from} ${a.qty} @ ${a.price} -> #${id}`,
        await venue.write.postAsk([b.inst, q.handle, p.handle, q.proof, p.proof], n(a.from)),
      );
      asks.push({ id, from: a.from });
    }
    askIds.set(b.inst, asks);

    console.log(`${b.symbol} — bids…`);
    const bids: { id: bigint; from: Who }[] = [];
    for (const bid of b.bids) {
      const q = await enc(bid.from, bid.qty);
      const p = await enc(bid.from, bid.price);
      const id = (await venue.read.ordersCount()) as bigint;
      await send(
        `postBid ${bid.from} ${bid.qty} @ ${bid.price} -> #${id}`,
        await venue.write.postBid([b.inst, q.handle, p.handle, q.proof, p.proof], n(bid.from)),
      );
      bids.push({ id, from: bid.from });
    }
    bidIds.set(b.inst, bids);
  }

  // ---- one trade on each side of every book
  //
  // The counterparty is always the OTHER account: `fill` and `hit` both reject a
  // self-trade, since with maker == taker both legs of a transfer resolve to one
  // storage slot and the second write silently wins.
  const other = (w: Who): Who => (w === "maker" ? "taker" : "maker");

  for (const b of BOOKS) {
    console.log(`\n${b.symbol} — trades…`);

    // A buyer lifts the best offer. The bid is set above the ask so it crosses;
    // settlement still charges the ASK, so bidding up does not overpay.
    const bestAsk = askIds.get(b.inst)![0];
    {
      const who = other(bestAsk.from);
      const bid = await enc(who, b.asks[0].price + 10_000n);
      const q = await enc(who, b.liftQty);
      const fillId = (await venue.read.fillsCount()) as bigint;
      await send(
        `fill ask #${bestAsk.id} for ${b.liftQty} -> trade #${fillId}`,
        await venue.write.fill([bestAsk.id, bid.handle, q.handle, bid.proof, q.proof, STANDARD], n(who)),
      );
      // The reporting entity is the ORDER'S maker, whichever side lifted it.
      await send(`reportTrade #${fillId}`, await venue.write.reportTrade([fillId], n(bestAsk.from)));
      await send(`publishVolume #${fillId}`, await venue.write.publishVolume([fillId], n(bestAsk.from)));
      // A fill parks the order in PendingResolution: the contract cannot read
      // its own encrypted result, so only the maker can clear it. Left pending,
      // the remainder would drop out of the book the demo is meant to show.
      await send(`reopen #${bestAsk.id}`, await venue.write.reopen([bestAsk.id], n(bestAsk.from)));
    }

    // A seller hits the best bid — the path that only exists on a two-sided book.
    const bestBid = bidIds.get(b.inst)![0];
    {
      const who = other(bestBid.from);
      const ask = await enc(who, b.bids[0].price - 10_000n);
      const q = await enc(who, b.sellQty);
      const fillId = (await venue.read.fillsCount()) as bigint;
      await send(
        `hit bid #${bestBid.id} for ${b.sellQty} -> trade #${fillId}`,
        await venue.write.hit([bestBid.id, ask.handle, q.handle, ask.proof, q.proof, STANDARD], n(who)),
      );
      await send(`reportTrade #${fillId}`, await venue.write.reportTrade([fillId], n(bestBid.from)));
      await send(`publishVolume #${fillId}`, await venue.write.publishVolume([fillId], n(bestBid.from)));
      await send(`reopen #${bestBid.id}`, await venue.write.reopen([bestBid.id], n(bestBid.from)));
    }
  }

  console.log(`\norders ${await venue.read.ordersCount()}   fills ${await venue.read.fillsCount()}`);
}

main().catch((e: any) => {
  console.error(`\nfailed: ${e.details ?? e.shortMessage ?? e.message}`);
  process.exitCode = 1;
});
