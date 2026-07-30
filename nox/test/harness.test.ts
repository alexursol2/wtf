/**
 * Proves the local harness itself works before any venue logic is tested.
 * If this fails, nothing else in the suite means anything.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { connect, bootstrapNoxCompute, NOX_COMPUTE_LOCAL } from "./helpers/nox.js";

describe("local Nox harness", () => {
  let ctx: any;

  before(async () => {
    const { viem, provider } = await connect();
    const boot = await bootstrapNoxCompute(viem, provider);
    ctx = { viem, provider, ...boot };
  });

  it("installs NoxCompute at the SDK's hardcoded local address", async () => {
    const code = await ctx.publicClient.getCode({ address: NOX_COMPUTE_LOCAL });
    assert.ok(code && code.length > 2, "no bytecode at the hardcoded address");
  });

  it("is initialised with our gateway as the trusted proof signer", async () => {
    const gatewayOnChain = await ctx.publicClient.readContract({
      address: NOX_COMPUTE_LOCAL,
      abi: ctx.abi,
      functionName: "gateway",
    });
    assert.equal(
      (gatewayOnChain as string).toLowerCase(),
      ctx.gateway.address.toLowerCase(),
    );
  });
});
