/**
 * DeferralVenue — Layer 3.
 *
 * Read test/helpers/nox.ts for what this harness can and cannot prove. In
 * short: it proves the venue EXECUTES and that ACL GRANTS LAND. It cannot
 * assert decrypted amounts, because no TEE Runner resolves values locally.
 *
 * The most valuable test in this file is "fill() publishes nothing". That is
 * the vulnerability described in the plan: because `crosses` is an unreadable
 * ebool, an allowPublicDecryption(price) inside fill() would execute
 * unconditionally, letting anyone print the entire order book with zero-value
 * fills — permanently, since Nox has no un-publish primitive. It is asserted
 * directly against NoxCompute state rather than by reading the source.
 */
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  connect,
  bootstrapNoxCompute,
  makeInputProof,
  buildHandle,
  NOX_COMPUTE_LOCAL,
  TEEType,
} from "./helpers/nox.js";

const CHAIN_ID = 31337;
const PRICE_SCALE = 10_000n; // 98.7500 -> 987500
const LIS_DEFERRAL = 90n; // demo value, matches the contract
/** Instrument index. Plaintext on the order, so the book can be split by pair. */
const INSTRUMENT = 0;

/**
 * Struct slots by name.
 *
 * These were positional destructures until the book became two-sided and
 * `side`, `instrument` and `cashRemaining` shifted everything along. Positional
 * reads fail SILENTLY there — a test asserting on `price` starts asserting on
 * `cashRemaining` and can still pass — so the layout is written down once.
 */
const ORDER = {
  maker: 0,
  side: 1,
  instrument: 2,
  qtyRemaining: 3,
  cashRemaining: 4,
  price: 5,
  expiry: 6,
  state: 7,
} as const;

const FILL = {
  maker: 0,
  taker: 1,
  instrument: 2,
  qty: 3,
  price: 4,
  bucket: 5,
  deferredUntil: 6,
  reported: 7,
  published: 8,
} as const;

describe("DeferralVenue", () => {
  let ctx: any;
  let venue: any;
  let registry: any;
  let salt = 1;

  /** Fresh unique input handle + matching gateway proof, bound to `app`. */
  async function encInput(owner: Hex, app: Hex, teeType: number = TEEType.Uint256) {
    const handle = buildHandle(CHAIN_ID, teeType, salt++);
    const proof = await makeInputProof({
      gateway: ctx.gateway,
      chainId: CHAIN_ID,
      handle,
      owner,
      app,
    });
    return { handle, proof };
  }

  const noxRead = (functionName: string, args: any[]) =>
    ctx.publicClient.readContract({
      address: NOX_COMPUTE_LOCAL,
      abi: ctx.abi,
      functionName,
      args,
    });

  before(async () => {
    const { viem, provider, networkHelpers } = await connect();
    const boot = await bootstrapNoxCompute(viem, provider);
    ctx = { viem, provider, networkHelpers, ...boot };
  });

  beforeEach(async () => {
    const [deployer, maker, taker, auditor] = await ctx.viem.getWalletClients();
    ctx.maker = maker;
    ctx.taker = taker;
    ctx.auditor = auditor;

    registry = await ctx.viem.deployContract("MockIdentityRegistry");
    venue = await ctx.viem.deployContract("DeferralVenue", [
      registry.address,
      auditor.account.address,
    ]);

    // Identity is a PLAINTEXT gate — reverting on it leaks nothing about amounts.
    for (const who of [maker, taker, auditor, deployer]) {
      await registry.write.setVerified([who.account.address, true]);
    }
  });

  /** maker posts an ask; returns orderId */
  async function postAsk(expirySeconds = 3600) {
    const qty = await encInput(ctx.maker.account.address, venue.address);
    const price = await encInput(ctx.maker.account.address, venue.address);
    const latest = await ctx.publicClient.getBlock();
    const expiry = BigInt(latest.timestamp) + BigInt(expirySeconds);

    await venue.write.postAsk([INSTRUMENT, qty.handle, price.handle, qty.proof, price.proof, expiry], {
      account: ctx.maker.account,
    });
    return 0n;
  }

  /** taker posts a resting BID; returns orderId */
  async function postBid(expirySeconds = 3600) {
    const qty = await encInput(ctx.taker.account.address, venue.address);
    const price = await encInput(ctx.taker.account.address, venue.address);
    const latest = await ctx.publicClient.getBlock();
    const expiry = BigInt(latest.timestamp) + BigInt(expirySeconds);

    const id = await venue.read.ordersCount();
    await venue.write.postBid([INSTRUMENT, qty.handle, price.handle, qty.proof, price.proof, expiry], {
      account: ctx.taker.account,
    });
    return id;
  }

  /** maker sells into a resting bid */
  async function hit(orderId: bigint, bucket: number) {
    const ask = await encInput(ctx.maker.account.address, venue.address);
    const offerQty = await encInput(ctx.maker.account.address, venue.address);
    await venue.write.hit([orderId, ask.handle, offerQty.handle, ask.proof, offerQty.proof, bucket], {
      account: ctx.maker.account,
    });
  }

  /** taker fills; bucket 0 = Standard, 1 = LargeInScale */
  async function fill(orderId: bigint, bucket: number) {
    const bid = await encInput(ctx.taker.account.address, venue.address);
    const wantQty = await encInput(ctx.taker.account.address, venue.address);
    await venue.write.fill([orderId, bid.handle, wantQty.handle, bid.proof, wantQty.proof, bucket], {
      account: ctx.taker.account,
    });
    return 0n;
  }

  async function depositBoth() {
    const mc = await encInput(ctx.maker.account.address, venue.address);
    await venue.write.depositCash([mc.handle, mc.proof], { account: ctx.maker.account });
    const tc = await encInput(ctx.taker.account.address, venue.address);
    await venue.write.depositCash([tc.handle, tc.proof], { account: ctx.taker.account });
    const ms = await encInput(ctx.maker.account.address, venue.address);
    await venue.write.depositShares([ms.handle, ms.proof], { account: ctx.maker.account });
  }

  // ------------------------------------------------------------------

  it("exposes the PRICE_SCALE convention the tape depends on", async () => {
    assert.equal(await venue.read.PRICE_SCALE(), PRICE_SCALE);
    assert.equal(await venue.read.LIS_DEFERRAL(), LIS_DEFERRAL);
  });

  it("rejects unverified callers on plaintext identity, before any ciphertext work", async () => {
    const [, , , , stranger] = await ctx.viem.getWalletClients();
    const enc = await encInput(stranger.account.address, venue.address);
    await assert.rejects(
      venue.write.depositCash([enc.handle, enc.proof], { account: stranger.account }),
      /not verified/,
    );
  });

  it("escrows a deposit and grants the depositor a persistent viewer grant", async () => {
    const enc = await encInput(ctx.maker.account.address, venue.address);
    await venue.write.depositCash([enc.handle, enc.proof], { account: ctx.maker.account });

    const handle = await venue.read.escrowCash([ctx.maker.account.address]);
    assert.notEqual(handle, `0x${"00".repeat(32)}`, "escrow handle never materialised");

    // The two grants that keep the balance alive and readable. A missing
    // allowThis here is the classic dead-handle bug: the frontend shows an
    // empty balance and it looks exactly like async lag.
    assert.equal(await noxRead("isAllowed", [handle, venue.address]), true, "contract lost compute access");
    assert.equal(
      await noxRead("isViewer", [handle, ctx.maker.account.address]),
      true,
      "depositor cannot decrypt their own balance",
    );
  });

  it("posts an ask and keeps the order's live price handle unpublished", async () => {
    await depositBoth();
    const orderId = await postAsk();

    const order = await venue.read.orders([orderId]);
    const o = order as any[];
    const maker = o[ORDER.maker], qtyRemaining = o[ORDER.qtyRemaining], price = o[ORDER.price];
    assert.equal(maker.toLowerCase(), ctx.maker.account.address.toLowerCase());
    assert.equal(await noxRead("isAllowed", [qtyRemaining, venue.address]), true);
    assert.equal(await noxRead("isViewer", [price, ctx.maker.account.address]), true);

    // A resting order's price must never be public.
    assert.equal(await noxRead("isPubliclyDecryptable", [price]), false);
  });

  it("rejects a fill on an expired order", async () => {
    await depositBoth();
    const orderId = await postAsk(60);
    await ctx.networkHelpers.time.increase(120);
    await assert.rejects(fill(orderId, 0), /expired/);
  });

  // ---------------- the security property ----------------

  it("fill() publishes NOTHING — no price, no volume", async () => {
    await depositBoth();
    const orderId = await postAsk();
    await fill(orderId, 1);

    const f = await venue.read.fills([0n]);
    const fa = f as any[];
    const fqty = fa[FILL.qty], fprice = fa[FILL.price];

    // This is the whole security fix. Had disclosure lived in fill(), an
    // attacker could fill every open order with an encrypted bid of 1 —
    // every quantity collapses to zero, no money moves, and yet every
    // maker's price becomes permanently public.
    assert.equal(await noxRead("isPubliclyDecryptable", [fprice]), false, "fill() published the price");
    assert.equal(await noxRead("isPubliclyDecryptable", [fqty]), false, "fill() published the volume");

    const order = await venue.read.orders([orderId]);
    assert.equal(
      await noxRead("isPubliclyDecryptable", [(order as any[])[ORDER.price]]),
      false,
      "fill() published the live order price",
    );
  });

  it("keeps the fill's quantity handle alive for a deferred publishVolume", async () => {
    await depositBoth();
    const orderId = await postAsk();
    await fill(orderId, 1);

    const fa = (await venue.read.fills([0n])) as any[];
    const fqty = fa[FILL.qty], fprice = fa[FILL.price];

    // Both must survive into LATER transactions — reportTrade and
    // publishVolume, the latter possibly days after. Miss the allowThis and
    // deferred publication hits a dead handle, discovered only after the
    // deferral elapses (i.e. after filming).
    assert.equal(await noxRead("isAllowed", [fqty, venue.address]), true, "fill qty handle went dead");
    assert.equal(await noxRead("isAllowed", [fprice, venue.address]), true, "snapshot price went dead");

    // The regulator sees volume from block one — this is the regulatory story.
    assert.equal(
      await noxRead("isViewer", [fqty, ctx.auditor.account.address]),
      true,
      "auditor was not granted the fill volume",
    );
  });

  it("rejects a self-fill, which would otherwise credit the filler", async () => {
    await depositBoth();
    const orderId = await postAsk();

    // Without the guard this is a live balance bug, not just a wash trade:
    // escrowCash[msg.sender] and escrowCash[o.maker] resolve to the same handle
    // and the same storage slot, so the debit is overwritten by the credit.
    const bid = await encInput(ctx.maker.account.address, venue.address);
    const wantQty = await encInput(ctx.maker.account.address, venue.address);
    await assert.rejects(
      venue.write.fill([orderId, bid.handle, wantQty.handle, bid.proof, wantQty.proof, 0], {
        account: ctx.maker.account,
      }),
      /self fill/,
    );
  });

  it("blocks a cancel racing an unresolved fill", async () => {
    await depositBoth();
    const orderId = await postAsk();
    await fill(orderId, 0);
    await assert.rejects(
      venue.write.cancel([orderId], { account: ctx.maker.account }),
      /pending or cancelled/,
    );
  });

  // ---------------- disclosure ----------------

  it("only the maker may report — the maker IS the reporting entity", async () => {
    await depositBoth();
    const orderId = await postAsk();
    await fill(orderId, 0);

    await assert.rejects(
      venue.write.reportTrade([0n], { account: ctx.taker.account }),
      /reporting entity/,
    );
  });

  it("reportTrade publishes the price snapshot but NOT the volume", async () => {
    await depositBoth();
    const orderId = await postAsk();
    await fill(orderId, 1);

    await venue.write.reportTrade([0n], { account: ctx.maker.account });

    const fa = (await venue.read.fills([0n])) as any[];
    const fqty = fa[FILL.qty], fprice = fa[FILL.price];
    assert.equal(await noxRead("isPubliclyDecryptable", [fprice]), true, "price did not print");
    assert.equal(await noxRead("isPubliclyDecryptable", [fqty]), false, "volume printed too early");

    // ...and the still-resting order's own price handle stays private, which is
    // exactly why the fill snapshots the price into a fresh handle.
    const order = await venue.read.orders([orderId]);
    assert.equal(await noxRead("isPubliclyDecryptable", [(order as any[])[ORDER.price]]), false);
  });

  it("defers volume for a large-in-scale fill, then publishes it", async () => {
    await depositBoth();
    const orderId = await postAsk();
    await fill(orderId, 1); // LargeInScale

    await venue.write.reportTrade([0n], { account: ctx.maker.account });

    // Within the deferral window the print is refused.
    await assert.rejects(venue.write.publishVolume([0n], { account: ctx.maker.account }), /deferred/);

    await ctx.networkHelpers.time.increase(Number(LIS_DEFERRAL) + 1);
    await venue.write.publishVolume([0n], { account: ctx.maker.account });

    const fqty = ((await venue.read.fills([0n])) as any[])[FILL.qty];
    assert.equal(await noxRead("isPubliclyDecryptable", [fqty]), true, "volume never printed");
  });

  it("publishes a standard-bucket fill's volume immediately", async () => {
    await depositBoth();
    const orderId = await postAsk();
    await fill(orderId, 0); // Standard — no deferral

    await venue.write.reportTrade([0n], { account: ctx.maker.account });
    await venue.write.publishVolume([0n], { account: ctx.maker.account });

    const fqty = ((await venue.read.fills([0n])) as any[])[FILL.qty];
    assert.equal(await noxRead("isPubliclyDecryptable", [fqty]), true);
  });

  it("refuses to publish volume for an unreported fill, and refuses to double-report", async () => {
    await depositBoth();
    const orderId = await postAsk();
    await fill(orderId, 0);

    await assert.rejects(venue.write.publishVolume([0n], { account: ctx.maker.account }), /not reported/);

    await venue.write.reportTrade([0n], { account: ctx.maker.account });
    await assert.rejects(venue.write.reportTrade([0n], { account: ctx.maker.account }), /reported/);

    await venue.write.publishVolume([0n], { account: ctx.maker.account });
    await assert.rejects(venue.write.publishVolume([0n], { account: ctx.maker.account }), /published/);
  });

  // ---------------- who can see what ----------------

  it("gives the auditor the volume while the public still cannot see it", async () => {
    // The core Task 3 claim, and the reason the auditor grant happens at fill
    // rather than at reportTrade: the regulator is ahead of the public.
    // An ephemeral random address stands in for "the public" — a fresh key each
    // run cannot have been accidentally granted anything.
    const outsider = privateKeyToAccount(generatePrivateKey());

    await depositBoth();
    const orderId = await postAsk();
    await fill(orderId, 1); // LargeInScale, so volume is deferred

    const fqty = ((await venue.read.fills([0n])) as any[])[FILL.qty];

    assert.equal(
      await noxRead("isViewer", [fqty, ctx.auditor.account.address]),
      true,
      "auditor cannot see the volume",
    );
    assert.equal(
      await noxRead("isViewer", [fqty, outsider.address]),
      false,
      "an unrelated address can see the volume",
    );
    assert.equal(await noxRead("isPubliclyDecryptable", [fqty]), false, "volume is already public");
  });

  it("closes the gap only once the volume is published", async () => {
    const outsider = privateKeyToAccount(generatePrivateKey());

    await depositBoth();
    const orderId = await postAsk();
    await fill(orderId, 0); // Standard — publishable immediately
    await venue.write.reportTrade([0n], { account: ctx.maker.account });

    const fqty = ((await venue.read.fills([0n])) as any[])[FILL.qty];

    // Before publication the outsider is shut out...
    assert.equal(await noxRead("isViewer", [fqty, outsider.address]), false);

    await venue.write.publishVolume([0n], { account: ctx.maker.account });

    // ...and afterwards everyone can read it. This is the positive control:
    // it proves the check above is measuring access, not a broken read.
    assert.equal(await noxRead("isPubliclyDecryptable", [fqty]), true);
    assert.equal(
      await noxRead("isViewer", [fqty, outsider.address]),
      true,
      "publication did not actually make the volume readable",
    );
  });

  it("keeps a counterparty out of the other side's escrow balance", async () => {
    await depositBoth();

    const makerCash = await venue.read.escrowCash([ctx.maker.account.address]);
    const takerCash = await venue.read.escrowCash([ctx.taker.account.address]);

    assert.equal(await noxRead("isViewer", [makerCash, ctx.maker.account.address]), true);
    assert.equal(
      await noxRead("isViewer", [makerCash, ctx.taker.account.address]),
      false,
      "the taker can read the maker's cash balance",
    );
    assert.equal(
      await noxRead("isViewer", [takerCash, ctx.maker.account.address]),
      false,
      "the maker can read the taker's cash balance",
    );
  });

  // ---------------- lifecycle ----------------

  it("lets the maker reopen after confirming resolution, then cancel to reclaim", async () => {
    await depositBoth();
    const orderId = await postAsk();
    await fill(orderId, 0);

    await assert.rejects(venue.write.reopen([orderId], { account: ctx.taker.account }), /not maker/);
    await venue.write.reopen([orderId], { account: ctx.maker.account });

    await venue.write.cancel([orderId], { account: ctx.maker.account });

    const order = await venue.read.orders([orderId]);
    assert.equal((order as any[])[ORDER.state], 2, "order should be Cancelled");

    // The reclaimed balance must stay readable by the maker.
    const shares = await venue.read.escrowShares([ctx.maker.account.address]);
    assert.equal(await noxRead("isViewer", [shares, ctx.maker.account.address]), true);
  });

  // ---------------- circuit breakers ----------------

  it("starts unpaused and lets only the auditor arm the breaker", async () => {
    assert.equal(await venue.read.paused(), false);

    await assert.rejects(
      venue.write.setPaused([true], { account: ctx.maker.account }),
      /not auditor/,
      "a maker must not be able to halt the venue",
    );

    await venue.write.setPaused([true], { account: ctx.auditor.account });
    assert.equal(await venue.read.paused(), true);
  });

  it("blocks new orders and fills while paused, and resumes cleanly", async () => {
    await depositBoth();
    const orderId = await postAsk();

    await venue.write.setPaused([true], { account: ctx.auditor.account });

    // Both entry points are gated in PLAINTEXT. That is the point: a paused
    // venue must refuse loudly, not settle encrypted trades for zero.
    const qty = await encInput(ctx.maker.account.address, venue.address);
    const price = await encInput(ctx.maker.account.address, venue.address);
    const latest = await ctx.publicClient.getBlock();
    await assert.rejects(
      venue.write.postAsk(
        [INSTRUMENT, qty.handle, price.handle, qty.proof, price.proof, BigInt(latest.timestamp) + 3600n],
        { account: ctx.maker.account },
      ),
      /paused/,
    );
    await assert.rejects(fill(orderId, 0), /paused/);

    await venue.write.setPaused([false], { account: ctx.auditor.account });
    await fill(orderId, 0); // resumes without any repair step
    assert.equal(await venue.read.fillsCount(), 1n);
  });

  it("freezes a fill's disclosure without touching its settlement", async () => {
    await depositBoth();
    const orderId = await postAsk();
    await fill(orderId, 1);

    await assert.rejects(
      venue.write.setFillFrozen([0n, true], { account: ctx.maker.account }),
      /not auditor/,
    );
    await assert.rejects(
      venue.write.setFillFrozen([99n, true], { account: ctx.auditor.account }),
      /no such fill/,
    );

    await venue.write.setFillFrozen([0n, true], { account: ctx.auditor.account });
    assert.equal(await venue.read.fillFrozen([0n]), true);

    // Disclosure is blocked...
    await assert.rejects(
      venue.write.reportTrade([0n], { account: ctx.maker.account }),
      /frozen/,
    );

    // ...but the trade itself already happened. The fill record stands, and the
    // auditor still holds the volume grant it was given at settlement. Freezing
    // is a disclosure control, not an unwind — there is no un-transfer.
    const f = await venue.read.fills([0n]);
    const qtyHandle = (f as any[])[FILL.qty];
    assert.equal(await noxRead("isViewer", [qtyHandle, ctx.auditor.account.address]), true);
    assert.equal(await noxRead("isPubliclyDecryptable", [qtyHandle]), false);

    // Clearing the freeze restores the maker's ability to print.
    await venue.write.setFillFrozen([0n, false], { account: ctx.auditor.account });
    await venue.write.reportTrade([0n], { account: ctx.maker.account });
    assert.equal((await venue.read.fills([0n]))[FILL.reported], true, "fill should now be reported");
  });

  // ---------------- the bid side ----------------

  it("rests a bid that escrows CASH, not shares", async () => {
    await depositBoth();
    const bidId = await postBid();

    const o = (await venue.read.orders([bidId])) as any[];
    assert.equal(o[ORDER.side], 1, "order should be a Bid");
    assert.equal(o[ORDER.maker].toLowerCase(), ctx.taker.account.address.toLowerCase());

    // The cash leg is what a bid locks up, and the maker must still be able to
    // read it — otherwise cancelling returns a balance they cannot verify.
    assert.equal(await noxRead("isAllowed", [o[ORDER.cashRemaining], venue.address]), true);
    assert.equal(
      await noxRead("isViewer", [o[ORDER.cashRemaining], ctx.taker.account.address]),
      true,
      "bidder cannot read their own escrowed cash",
    );
    // A resting bid's price is as secret as a resting ask's.
    assert.equal(await noxRead("isPubliclyDecryptable", [o[ORDER.price]]), false);
  });

  it("refuses to cross the two sides' entry points", async () => {
    await depositBoth();
    const askId = await postAsk();
    const bidId = await postBid();

    // hit() takes bids, fill() takes asks. Mixing them would move the wrong
    // leg, so both are rejected in plaintext before any ciphertext work.
    await assert.rejects(hit(askId, 0), /not a bid/);

    const bid = await encInput(ctx.taker.account.address, venue.address);
    const q = await encInput(ctx.taker.account.address, venue.address);
    await assert.rejects(
      venue.write.fill([bidId, bid.handle, q.handle, bid.proof, q.proof, 0], {
        account: ctx.taker.account,
      }),
      /not an ask/,
    );
  });

  it("settles a hit against a resting bid and grants the auditor the volume", async () => {
    await depositBoth();
    const bidId = await postBid();
    await hit(bidId, 1);

    assert.equal(await venue.read.fillsCount(), 1n);

    const f = (await venue.read.fills([0n])) as any[];
    // The REPORTING ENTITY is the order's maker — the bidder here — not whoever
    // lifted it. Who quoted decides the obligation.
    assert.equal(f[FILL.maker].toLowerCase(), ctx.taker.account.address.toLowerCase());
    assert.equal(f[FILL.taker].toLowerCase(), ctx.maker.account.address.toLowerCase());

    // Same disclosure guarantees as the ask path: regulator sees it now, the
    // public sees nothing until it is reported.
    assert.equal(await noxRead("isViewer", [f[FILL.qty], ctx.auditor.account.address]), true);
    assert.equal(await noxRead("isPubliclyDecryptable", [f[FILL.qty]]), false);
    assert.equal(await noxRead("isPubliclyDecryptable", [f[FILL.price]]), false);
  });

  it("rejects a self-hit, which would collide both legs in one slot", async () => {
    await depositBoth();
    const bidId = await postBid();

    const ask = await encInput(ctx.taker.account.address, venue.address);
    const q = await encInput(ctx.taker.account.address, venue.address);
    await assert.rejects(
      venue.write.hit([bidId, ask.handle, q.handle, ask.proof, q.proof, 0], {
        account: ctx.taker.account,
      }),
      /self fill/,
    );
  });

  it("returns CASH when a bid is cancelled, not shares", async () => {
    await depositBoth();
    const bidId = await postBid();
    await venue.write.cancel([bidId], { account: ctx.taker.account });

    assert.equal((await venue.read.orders([bidId]))[ORDER.state], 2, "bid should be Cancelled");

    const cash = await venue.read.escrowCash([ctx.taker.account.address]);
    assert.equal(
      await noxRead("isViewer", [cash, ctx.taker.account.address]),
      true,
      "reclaimed cash is unreadable by its owner",
    );
  });

  it("tags orders and fills with their instrument, in plaintext", async () => {
    await depositBoth();

    const qty = await encInput(ctx.maker.account.address, venue.address);
    const price = await encInput(ctx.maker.account.address, venue.address);
    const latest = await ctx.publicClient.getBlock();
    await venue.write.postAsk(
      [7, qty.handle, price.handle, qty.proof, price.proof, BigInt(latest.timestamp) + 3600n],
      { account: ctx.maker.account },
    );

    // Which security is quoted is not the secret — the size and price are — so
    // it stays readable, which is the whole reason separate books are possible.
    assert.equal((await venue.read.orders([0n]))[ORDER.instrument], 7);

    await fill(0n, 0);
    assert.equal(
      (await venue.read.fills([0n]))[FILL.instrument],
      7,
      "the fill did not inherit its order's instrument",
    );
  });

  // ---------------- withdrawal ----------------

  it("lets escrow leave the venue, and keeps the remainder readable", async () => {
    await depositBoth();

    const w = await encInput(ctx.maker.account.address, venue.address);
    await venue.write.withdrawCash([w.handle, w.proof], { account: ctx.maker.account });

    const handle = await venue.read.escrowCash([ctx.maker.account.address]);
    assert.equal(await noxRead("isAllowed", [handle, venue.address]), true);
    assert.equal(
      await noxRead("isViewer", [handle, ctx.maker.account.address]),
      true,
      "withdrawing left the owner unable to read what remains",
    );

    const ws = await encInput(ctx.maker.account.address, venue.address);
    await venue.write.withdrawShares([ws.handle, ws.proof], { account: ctx.maker.account });
    const sharesHandle = await venue.read.escrowShares([ctx.maker.account.address]);
    assert.equal(await noxRead("isViewer", [sharesHandle, ctx.maker.account.address]), true);
  });

  it("does not revert when withdrawing more than is held", async () => {
    // Over-withdrawing moves zero. Reverting would confirm the size of a
    // balance the venue is otherwise unable to disclose.
    const w = await encInput(ctx.maker.account.address, venue.address);
    await venue.write.withdrawCash([w.handle, w.proof], { account: ctx.maker.account });
    assert.equal(await venue.read.ordersCount(), 0n);
  });
});
