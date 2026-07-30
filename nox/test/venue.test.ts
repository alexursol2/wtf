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

    await venue.write.postAsk([qty.handle, price.handle, qty.proof, price.proof, expiry], {
      account: ctx.maker.account,
    });
    return 0n;
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
    const [maker, qtyRemaining, price] = order as any[];
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
    const [, , fqty, fprice] = f as any[];

    // This is the whole security fix. Had disclosure lived in fill(), an
    // attacker could fill every open order with an encrypted bid of 1 —
    // every quantity collapses to zero, no money moves, and yet every
    // maker's price becomes permanently public.
    assert.equal(await noxRead("isPubliclyDecryptable", [fprice]), false, "fill() published the price");
    assert.equal(await noxRead("isPubliclyDecryptable", [fqty]), false, "fill() published the volume");

    const order = await venue.read.orders([orderId]);
    assert.equal(
      await noxRead("isPubliclyDecryptable", [(order as any[])[2]]),
      false,
      "fill() published the live order price",
    );
  });

  it("keeps the fill's quantity handle alive for a deferred publishVolume", async () => {
    await depositBoth();
    const orderId = await postAsk();
    await fill(orderId, 1);

    const [, , fqty, fprice] = (await venue.read.fills([0n])) as any[];

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

    const [, , fqty, fprice] = (await venue.read.fills([0n])) as any[];
    assert.equal(await noxRead("isPubliclyDecryptable", [fprice]), true, "price did not print");
    assert.equal(await noxRead("isPubliclyDecryptable", [fqty]), false, "volume printed too early");

    // ...and the still-resting order's own price handle stays private, which is
    // exactly why the fill snapshots the price into a fresh handle.
    const order = await venue.read.orders([orderId]);
    assert.equal(await noxRead("isPubliclyDecryptable", [(order as any[])[2]]), false);
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

    const [, , fqty] = (await venue.read.fills([0n])) as any[];
    assert.equal(await noxRead("isPubliclyDecryptable", [fqty]), true, "volume never printed");
  });

  it("publishes a standard-bucket fill's volume immediately", async () => {
    await depositBoth();
    const orderId = await postAsk();
    await fill(orderId, 0); // Standard — no deferral

    await venue.write.reportTrade([0n], { account: ctx.maker.account });
    await venue.write.publishVolume([0n], { account: ctx.maker.account });

    const [, , fqty] = (await venue.read.fills([0n])) as any[];
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

  // ---------------- lifecycle ----------------

  it("lets the maker reopen after confirming resolution, then cancel to reclaim", async () => {
    await depositBoth();
    const orderId = await postAsk();
    await fill(orderId, 0);

    await assert.rejects(venue.write.reopen([orderId], { account: ctx.taker.account }), /not maker/);
    await venue.write.reopen([orderId], { account: ctx.maker.account });

    await venue.write.cancel([orderId], { account: ctx.maker.account });

    const order = await venue.read.orders([orderId]);
    assert.equal((order as any[])[4], 2, "order should be Cancelled");

    // The reclaimed balance must stay readable by the maker.
    const shares = await venue.read.escrowShares([ctx.maker.account.address]);
    assert.equal(await noxRead("isViewer", [shares, ctx.maker.account.address]), true);
  });
});
