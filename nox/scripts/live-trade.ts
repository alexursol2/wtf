/**
 * One real trade against a live deployment, with every encrypted value
 * decrypted and checked.
 *
 * This is the first genuine test of the fill arithmetic. The local suite proves
 * that transactions execute and that ACL grants land, but no TEE Runner runs
 * locally, so `select`, `transfer` and `div` have never actually computed
 * anything. Everything below is therefore an assertion about real numbers.
 *
 * The trade:
 *   maker posts  1,000 bonds @ 98.7500  (price 987500, PRICE_SCALE 1e4)
 *   taker bids     600 bonds @ 99.0000  (bid 990000) -> crosses
 *   expected fill: 600 bonds, notional 600 * 987500 / 10000 = 59,250
 *                  ^ settles at the MAKER's price, not the taker's bid
 *
 * Reads addresses from deployments/venue.sepolia.json.
 *
 *   npx hardhat run scripts/live-trade.ts --network sepolia
 */
import { network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { createViemHandleClient } from "@iexec-nox/handle";
import { loadEnv, roleWalletClient, isTransient } from "../lib/env.js";
import type { Hex } from "viem";

const ASK_QTY = 1_000n;
const ASK_PRICE = 987_500n; // 98.7500
const BID_PRICE = 990_000n; // 99.0000 — crosses
const WANT_QTY = 600n;

const CASH_FUNDING = 5_000_000n;
const PRICE_SCALE = 10_000n;

const EXPECTED_FILL = WANT_QTY; // 600 < 1000, so the taker's size wins
const EXPECTED_NOTIONAL = (WANT_QTY * ASK_PRICE) / PRICE_SCALE; // 59,250

const RESOLVE_TIMEOUT_MS = 120_000;
const t0 = Date.now();
const stamp = () => `[+${((Date.now() - t0) / 1000).toFixed(0)}s]`;

let pass = 0;
let fail = 0;

function check(label: string, actual: bigint | null, expected: bigint) {
  if (actual === null) {
    console.log(`  UNRESOLVED  ${label} (expected ${expected})`);
    fail++;
    return;
  }
  if (actual === expected) {
    console.log(`  ok          ${label} = ${actual}`);
    pass++;
  } else {
    console.log(`  MISMATCH    ${label} = ${actual}, expected ${expected}`);
    fail++;
  }
}

async function main() {
  loadEnv();
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const clients = await viem.getWalletClients();
  const [deployer, maker, taker, auditor] = clients;

  if (!maker || !taker) throw new Error("need PRIVATE_KEY_MAKER and PRIVATE_KEY_TAKER");
  if (maker.account.address === taker.account.address) {
    throw new Error("maker and taker are the same address — fill() rejects a self-fill");
  }

  const record = path.join(import.meta.dirname, "..", "..", "deployments", `venue.sepolia.json`);
  const d = JSON.parse(fs.readFileSync(record, "utf8"));
  if (d.chainId !== chainId) throw new Error(`record is chain ${d.chainId}, connected to ${chainId}`);

  console.log(`\n=== live trade on chain ${chainId} ===`);
  console.log(`venue  ${d.venue}`);
  console.log(`maker  ${maker.account.address}`);
  console.log(`taker  ${taker.account.address}\n`);

  const venue = await viem.getContractAt("DeferralVenue", d.venue);

  // Per-signer nonce tracking: hosted RPCs report stale counts right after a send.
  const nonces = new Map<string, number>();
  for (const c of [deployer, maker, taker].filter(Boolean)) {
    nonces.set(
      c!.account.address,
      await publicClient.getTransactionCount({ address: c!.account.address, blockTag: "pending" }),
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
    console.log(`${stamp()} ${label}  (block ${r.blockNumber}, gas ${r.gasUsed})`);
    return r;
  };

  // Handle clients — one per party, each built on a DEDICATED single-account
  // wallet client. Passing a Hardhat wallet client here binds every proof to the
  // deployer, because the SDK reads getAddresses()[0] and Hardhat's transport
  // lists all configured keys. See roleWalletClient for the full story.
  const hcMaker = await createViemHandleClient(roleWalletClient("MAKER", chainId) as any);
  const hcTaker = await createViemHandleClient(roleWalletClient("TAKER", chainId) as any);
  const hcAuditor = auditor
    ? await createViemHandleClient(roleWalletClient("AUDITOR", chainId) as any)
    : null;

  /**
   * The gateway answers "not a viewer" (HTTP 403) both when you genuinely lack a
   * grant AND when the grant exists on-chain but its indexer has not caught up.
   * Those are the same message for opposite situations, so ask the chain, which
   * is authoritative: if NoxCompute says we are a viewer, a 403 is lag and worth
   * retrying; if it says we are not, fail immediately rather than spin.
   */
  const NOX_ADDRESS = "0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF" as const;
  const isViewerOnChain = (handle: string, who: string) =>
    publicClient.readContract({
      address: NOX_ADDRESS,
      abi: [
        {
          name: "isViewer",
          type: "function",
          stateMutability: "view",
          inputs: [{ type: "bytes32" }, { type: "address" }],
          outputs: [{ type: "bool" }],
        },
      ],
      functionName: "isViewer",
      args: [handle as Hex, who as Hex],
    }) as Promise<boolean>;

  async function decrypt(hc: any, handle: string, who?: string): Promise<bigint | null> {
    const deadline = Date.now() + RESOLVE_TIMEOUT_MS;
    let lastError = "";
    while (Date.now() < deadline) {
      try {
        const { value } = await hc.decrypt(handle);
        return BigInt(value);
      } catch (e: any) {
        lastError = e?.message ?? String(e);

        let retryable = isTransient(e);

        if (!retryable && /not a viewer|access_denied/i.test(lastError) && who) {
          const granted = await isViewerOnChain(handle, who).catch(() => false);
          if (granted) {
            retryable = true; // grant exists on-chain; the indexer is behind
          } else {
            console.log(`    (no viewer grant on-chain for ${who} — a real denial)`);
            return null;
          }
        }

        if (!retryable) {
          console.log(`    (non-transient: ${lastError})`);
          return null;
        }
        await new Promise((r) => setTimeout(r, 4_000));
      }
    }
    console.log(`    (timed out; last error: ${lastError})`);
    return null;
  }

  /** publicDecrypt has the same indexer lag, so poll it too. */
  async function publicDecrypt(hc: any, handle: string): Promise<bigint | null> {
    const deadline = Date.now() + RESOLVE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const r = await hc.publicDecrypt(handle);
        return BigInt(r.value);
      } catch {
        await new Promise((r) => setTimeout(r, 4_000));
      }
    }
    return null;
  }

  const enc = async (hc: any, who: any, value: bigint) => {
    const { handle, handleProof } = await hc.encryptInput(value, "uint256", d.venue);
    void who;
    return { handle, proof: handleProof };
  };

  // ---- opening balances -------------------------------------------------
  // Escrow accumulates across runs, so every expectation below is a DELTA on
  // what was already there. Absolute figures would pass once and then fail on
  // every re-run, which would look like a contract bug and is not one.
  console.log(`${stamp()} reading opening balances...`);
  const openTakerCash =
    (await decrypt(hcTaker, await venue.read.escrowCash([taker.account.address]), taker.account.address)) ?? 0n;
  const openMakerCash =
    (await decrypt(hcMaker, await venue.read.escrowCash([maker.account.address]), maker.account.address)) ?? 0n;
  const openTakerShares =
    (await decrypt(hcTaker, await venue.read.escrowShares([taker.account.address]), taker.account.address)) ?? 0n;
  console.log(
    `${stamp()}   taker cash ${openTakerCash}, maker cash ${openMakerCash}, taker shares ${openTakerShares}`,
  );

  // ---- escrow -----------------------------------------------------------
  console.log(`${stamp()} funding escrow (both legs encrypted)...`);
  const takerCash = await enc(hcTaker, taker, CASH_FUNDING);
  await send(
    "taker depositCash",
    await venue.write.depositCash([takerCash.handle, takerCash.proof], n(taker)),
  );

  const makerShares = await enc(hcMaker, maker, ASK_QTY);
  await send(
    "maker depositShares",
    await venue.write.depositShares([makerShares.handle, makerShares.proof], n(maker)),
  );

  // ---- post -------------------------------------------------------------
  const q = await enc(hcMaker, maker, ASK_QTY);
  const p = await enc(hcMaker, maker, ASK_PRICE);
  const now = (await publicClient.getBlock()).timestamp;
  const orderId = BigInt(Number(await venue.read.ordersCount()));

  await send(
    `maker postAsk ${ASK_QTY} @ ${ASK_PRICE}`,
    await venue.write.postAsk(
      [q.handle, p.handle, q.proof, p.proof, BigInt(now) + 3600n],
      n(maker),
    ),
  );

  // ---- fill -------------------------------------------------------------
  const bid = await enc(hcTaker, taker, BID_PRICE);
  const want = await enc(hcTaker, taker, WANT_QTY);
  const fillId = BigInt(Number(await venue.read.fillsCount()));

  await send(
    `taker fill ${WANT_QTY} @ bid ${BID_PRICE} (LargeInScale)`,
    await venue.write.fill([orderId, bid.handle, want.handle, bid.proof, want.proof, 1], n(taker)),
  );

  // ---- verify the arithmetic -------------------------------------------
  console.log(`\n${stamp()} decrypting results — the real test:`);

  const fill = (await venue.read.fills([fillId])) as unknown as any[];
  const [, , fillQtyHandle] = fill;

  const fillQty = await decrypt(hcMaker, fillQtyHandle, maker.account.address);
  check("fill quantity", fillQty, EXPECTED_FILL);

  const order = (await venue.read.orders([orderId])) as unknown as any[];
  const remaining = await decrypt(hcMaker, order[1], maker.account.address);
  check("order remaining", remaining, ASK_QTY - EXPECTED_FILL);

  const takerCashAfter = await decrypt(
    hcTaker,
    await venue.read.escrowCash([taker.account.address]),
    taker.account.address,
  );
  check("taker cash paid out", takerCashAfter, openTakerCash + CASH_FUNDING - EXPECTED_NOTIONAL);

  const makerCashAfter = await decrypt(
    hcMaker,
    await venue.read.escrowCash([maker.account.address]),
    maker.account.address,
  );
  check("maker cash received (notional)", makerCashAfter, openMakerCash + EXPECTED_NOTIONAL);

  const takerShares = await decrypt(
    hcTaker,
    await venue.read.escrowShares([taker.account.address]),
    taker.account.address,
  );
  check("taker shares received", takerShares, openTakerShares + EXPECTED_FILL);

  // ---- the disclosure regime -------------------------------------------
  console.log(`\n${stamp()} disclosure:`);

  if (hcAuditor) {
    const auditorView = await decrypt(hcAuditor, fillQtyHandle, auditor.account.address);
    check("auditor can read volume BEFORE the public", auditorView, EXPECTED_FILL);
  }

  await send("maker reportTrade", await venue.write.reportTrade([fillId], n(maker)));

  const priceHandle = fill[3];
  const publicPrice = await publicDecrypt(hcMaker, priceHandle);
  check("published price (anyone can read)", publicPrice, ASK_PRICE);

  const afterReport = (await venue.read.fills([fillId])) as unknown as any[];
  console.log(`  volumePublished = ${afterReport[7]} (must be false — deferred)`);
  if (afterReport[7] === false) pass++;
  else fail++;

  // ---- summary ----------------------------------------------------------
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  console.log(`notional convention: ${WANT_QTY} x ${ASK_PRICE} / ${PRICE_SCALE} = ${EXPECTED_NOTIONAL}`);
  console.log(`settled at the MAKER's price ${ASK_PRICE}, not the taker's bid ${BID_PRICE}`);
  console.log(`\norderId ${orderId}, fillId ${fillId}`);
  console.log(`volume publishes after LIS_DEFERRAL (${await venue.read.LIS_DEFERRAL()}s):`);
  console.log(`  npx hardhat run scripts/publish-volume.ts --network sepolia\n`);

  if (fail > 0) process.exitCode = 1;
}

main().catch((e: any) => {
  console.error(`\nlive trade failed: ${e.details ?? e.shortMessage ?? e.message}`);
  process.exitCode = 1;
});
