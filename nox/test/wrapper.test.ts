/**
 * ConfidentialWrapper — Layer 2.
 *
 * Covers the custody boundary: wrap (plaintext in, encrypted balance out),
 * confidential transfer, and the two-phase unwrap. Also covers the compliance
 * re-enforcement that answers the pooling problem — T-REX sees one holder of
 * record, so identity and country are re-checked here on every path that
 * credits an encrypted balance.
 *
 * See test/helpers/nox.ts on limits: ACL and control flow are provable here,
 * decrypted balances are not.
 */
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { parseUnits, padHex } from "viem";
import {
  connect,
  bootstrapNoxCompute,
  makeInputProof,
  makeDecryptionProof,
  buildHandle,
  NOX_COMPUTE_LOCAL,
  TEEType,
} from "./helpers/nox.js";

const CHAIN_ID = 31337;
const FRANCE = 250;
const RUSSIA = 643;

describe("ConfidentialWrapper", () => {
  let ctx: any;
  let wrapper: any;
  let bond: any;
  let registry: any;
  let salt = 5000;

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
    const [deployer, alice, bob] = await ctx.viem.getWalletClients();
    ctx.deployer = deployer;
    ctx.alice = alice;
    ctx.bob = bob;

    registry = await ctx.viem.deployContract("MockIdentityRegistry");
    bond = await ctx.viem.deployContract("MockERC20", ["Acme 2030 Senior Note", "ACME30", 18]);
    wrapper = await ctx.viem.deployContract("ConfidentialWrapper", [bond.address, registry.address]);

    for (const who of [alice, bob]) {
      await registry.write.setVerified([who.account.address, true]);
      await registry.write.setCountry([who.account.address, FRANCE]);
    }

    await bond.write.mint([alice.account.address, parseUnits("1000", 18)]);
    await bond.write.mint([bob.account.address, parseUnits("1000", 18)]);
  });

  async function wrapAs(who: any, amount: bigint) {
    await bond.write.approve([wrapper.address, amount], { account: who.account });
    await wrapper.write.wrap([amount], { account: who.account });
  }

  // ---------------- wrap ----------------

  it("takes custody of the underlying and issues an encrypted balance", async () => {
    const amount = parseUnits("100", 18);
    await wrapAs(ctx.alice, amount);

    assert.equal(await bond.read.balanceOf([wrapper.address]), amount, "underlying not in custody");

    const handle = await wrapper.read.balanceHandle([ctx.alice.account.address]);
    assert.notEqual(handle, padHex("0x0", { size: 32 }), "no encrypted balance handle");
    assert.equal(await noxRead("isAllowed", [handle, wrapper.address]), true);
    assert.equal(await noxRead("isViewer", [handle, ctx.alice.account.address]), true);

    // The holder's balance must never be public.
    assert.equal(await noxRead("isPubliclyDecryptable", [handle]), false);
  });

  it("re-enforces identity at the custody boundary", async () => {
    const [, , , stranger] = await ctx.viem.getWalletClients();
    await bond.write.mint([stranger.account.address, parseUnits("10", 18)]);
    await bond.write.approve([wrapper.address, parseUnits("10", 18)], { account: stranger.account });

    await assert.rejects(
      wrapper.write.wrap([parseUnits("10", 18)], { account: stranger.account }),
      /not verified/,
    );
  });

  it("re-enforces the country rule once the gate is active", async () => {
    // This is the mitigation for pooling: T-REX sees a single holder of record,
    // so the country rule is re-applied inside the confidential layer.
    await wrapper.write.setAllowedCountry([FRANCE, true], { account: ctx.deployer.account });
    await registry.write.setCountry([ctx.bob.account.address, RUSSIA]);

    await wrapAs(ctx.alice, parseUnits("10", 18)); // France — allowed

    await bond.write.approve([wrapper.address, parseUnits("10", 18)], { account: ctx.bob.account });
    await assert.rejects(
      wrapper.write.wrap([parseUnits("10", 18)], { account: ctx.bob.account }),
      /country/,
    );
  });

  it("lets only the owner manage the country list", async () => {
    await assert.rejects(
      wrapper.write.setAllowedCountry([FRANCE, true], { account: ctx.alice.account }),
      /not owner/,
    );
  });

  // ---------------- confidential transfer ----------------

  it("moves value confidentially and re-grants BOTH sides", async () => {
    await wrapAs(ctx.alice, parseUnits("100", 18));
    await wrapAs(ctx.bob, parseUnits("10", 18));

    const handle = buildHandle(CHAIN_ID, TEEType.Uint256, salt++);
    const proof = await makeInputProof({
      gateway: ctx.gateway,
      chainId: CHAIN_ID,
      handle,
      owner: ctx.alice.account.address,
      app: wrapper.address, // must be the calling CONTRACT, not the user
    });

    await wrapper.write.confidentialTransfer([ctx.bob.account.address, handle, proof], {
      account: ctx.alice.account,
    });

    const from = await wrapper.read.balanceHandle([ctx.alice.account.address]);
    const to = await wrapper.read.balanceHandle([ctx.bob.account.address]);

    // Every transfer mints three NEW handles; both balances need fresh grants
    // or the holder silently goes blind on their own balance.
    assert.equal(await noxRead("isAllowed", [from, wrapper.address]), true);
    assert.equal(await noxRead("isViewer", [from, ctx.alice.account.address]), true);
    assert.equal(await noxRead("isAllowed", [to, wrapper.address]), true);
    assert.equal(await noxRead("isViewer", [to, ctx.bob.account.address]), true);

    // Neither side leaks publicly.
    assert.equal(await noxRead("isPubliclyDecryptable", [from]), false);
    assert.equal(await noxRead("isPubliclyDecryptable", [to]), false);
  });

  it("re-enforces compliance on the RECIPIENT of a confidential transfer", async () => {
    await wrapAs(ctx.alice, parseUnits("100", 18));
    const [, , , stranger] = await ctx.viem.getWalletClients();

    const handle = buildHandle(CHAIN_ID, TEEType.Uint256, salt++);
    const proof = await makeInputProof({
      gateway: ctx.gateway,
      chainId: CHAIN_ID,
      handle,
      owner: ctx.alice.account.address,
      app: wrapper.address,
    });

    await assert.rejects(
      wrapper.write.confidentialTransfer([stranger.account.address, handle, proof], {
        account: ctx.alice.account,
      }),
      /not verified/,
    );
  });

  // ---------------- unwrap ----------------

  it("publishes only the success FLAG on an unwrap request, never a balance", async () => {
    await wrapAs(ctx.alice, parseUnits("100", 18));
    await wrapper.write.requestUnwrap([parseUnits("40", 18)], { account: ctx.alice.account });

    const req = (await wrapper.read.unwrapRequests([0n])) as any[];
    const okHandle = req[2];

    // The pass/fail flag is public by design — the user triggered it themselves.
    assert.equal(await noxRead("isPubliclyDecryptable", [okHandle]), true);

    // The balances behind it are not.
    const bal = await wrapper.read.balanceHandle([ctx.alice.account.address]);
    const locked = await wrapper.read.lockedHandle([ctx.alice.account.address]);
    assert.equal(await noxRead("isPubliclyDecryptable", [bal]), false);
    assert.equal(await noxRead("isPubliclyDecryptable", [locked]), false);
    assert.equal(await noxRead("isViewer", [locked, ctx.alice.account.address]), true);
  });

  it("releases the underlying against a proof the lock succeeded", async () => {
    const amount = parseUnits("40", 18);
    await wrapAs(ctx.alice, parseUnits("100", 18));

    const before = await bond.read.balanceOf([ctx.alice.account.address]);
    await wrapper.write.requestUnwrap([amount], { account: ctx.alice.account });

    const req = (await wrapper.read.unwrapRequests([0n])) as any[];
    const okProof = await makeDecryptionProof({
      gateway: ctx.gateway,
      chainId: CHAIN_ID,
      handle: req[2],
      decryptedResult: "0x01", // the TEE says: the lock funded
    });

    await wrapper.write.claimUnwrap([0n, okProof], { account: ctx.alice.account });

    assert.equal(
      await bond.read.balanceOf([ctx.alice.account.address]),
      before + amount,
      "underlying was not released",
    );
  });

  it("refuses to release when the lock did not fund — and never reverts the request itself", async () => {
    await wrapAs(ctx.alice, parseUnits("1", 18));

    // Branchless: an over-request does NOT revert. Reverting would leak the
    // balance. It records a request whose encrypted lock simply moved zero.
    await wrapper.write.requestUnwrap([parseUnits("999", 18)], { account: ctx.alice.account });

    const req = (await wrapper.read.unwrapRequests([0n])) as any[];
    const failProof = await makeDecryptionProof({
      gateway: ctx.gateway,
      chainId: CHAIN_ID,
      handle: req[2],
      decryptedResult: "0x00", // the TEE says: underfunded
    });

    await assert.rejects(
      wrapper.write.claimUnwrap([0n, failProof], { account: ctx.alice.account }),
      /underfunded/,
    );
    assert.equal(await bond.read.balanceOf([wrapper.address]), parseUnits("1", 18), "custody leaked");
  });

  it("rejects a forged success proof not signed by the gateway", async () => {
    await wrapAs(ctx.alice, parseUnits("100", 18));
    await wrapper.write.requestUnwrap([parseUnits("40", 18)], { account: ctx.alice.account });

    const forged = ("0x" + "11".repeat(65) + "01") as `0x${string}`;
    await assert.rejects(
      wrapper.write.claimUnwrap([0n, forged], { account: ctx.alice.account }),
      /.*/, // InvalidProof
    );
  });

  it("lets only the requester claim, and only once", async () => {
    await wrapAs(ctx.alice, parseUnits("100", 18));
    await wrapper.write.requestUnwrap([parseUnits("40", 18)], { account: ctx.alice.account });

    const req = (await wrapper.read.unwrapRequests([0n])) as any[];
    const okProof = await makeDecryptionProof({
      gateway: ctx.gateway,
      chainId: CHAIN_ID,
      handle: req[2],
      decryptedResult: "0x01",
    });

    await assert.rejects(
      wrapper.write.claimUnwrap([0n, okProof], { account: ctx.bob.account }),
      /not requester/,
    );

    await wrapper.write.claimUnwrap([0n, okProof], { account: ctx.alice.account });
    await assert.rejects(
      wrapper.write.claimUnwrap([0n, okProof], { account: ctx.alice.account }),
      /claimed/,
    );
  });
});
