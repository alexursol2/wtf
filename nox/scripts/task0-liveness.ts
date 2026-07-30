/**
 * Task 0 — BLOCKING infrastructure check.
 *
 * Proves the Nox OFF-CHAIN stack actually serves the target chain, by running a
 * full encrypt -> transact -> decrypt round trip. This is the one thing a
 * hardcoded contract address cannot tell you: NoxCompute existing on-chain says
 * nothing about whether an Ingestor and a TEE Runner are watching that chain and
 * resolving handles.
 *
 * Until this passes, the local test suite's coverage is structural only — no
 * encrypted value has ever materialised anywhere in this project.
 *
 * Success: a decrypted value comes back, and it equals what we encrypted.
 * Failure: the handle never resolves (NotYetComputedHandleError until timeout).
 *          In that case switch every network target to Arbitrum Sepolia.
 *
 *   npx hardhat run scripts/task0-liveness.ts --network sepolia
 */
import { network } from "hardhat";
import { createViemHandleClient, NotYetComputedHandleError, UnknownHandleError } from "@iexec-nox/handle";
import { formatEther } from "viem";
import { loadEnv } from "../lib/env.js";

/** How long to wait for the TEE Runner before calling it dead. */
const RESOLVE_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 5_000;

/** The plaintext we will encrypt, transact with, and try to read back. */
const SECRET = 424_242n;

const t0 = Date.now();
const stamp = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;

async function main() {
  loadEnv();

  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  const chainId = await publicClient.getChainId();

  console.log(`\n=== Task 0: Nox off-chain liveness on chain ${chainId} ===\n`);
  console.log(`${stamp()} deployer ${deployer.account.address}`);
  const balance = await publicClient.getBalance({ address: deployer.account.address });
  console.log(`${stamp()} balance  ${formatEther(balance)} ETH`);
  if (balance === 0n) throw new Error("deployer has no ETH — fund it before running Task 0");

  // ---- 1. a venue to transact against ------------------------------------
  // A mock registry is fine here: we are testing infrastructure, not the
  // product. Note the DeferralVenue constructor calls Nox.toEuint256, which is
  // a real NoxCompute call — so a successful deploy is itself a partial signal.
  //
  // Every send below is awaited to inclusion before the next is built.
  // `deployContract` already waits for confirmation; `contract.write.*` does
  // NOT, so those are wrapped in `settle`. Skipping that is what produced
  // "replacement transaction underpriced" and then "nonce too low" on the first
  // two attempts at this script, against a load-balanced public RPC that served
  // a stale eth_getTransactionCount.
  const settle = async (label: string, hash: `0x${string}`) => {
    const r = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`${stamp()}   ${label} mined in block ${r.blockNumber}`);
    return r;
  };

  console.log(`\n${stamp()} deploying MockIdentityRegistry...`);
  const registry = await viem.deployContract("MockIdentityRegistry", []);
  console.log(`${stamp()}   ${registry.address}`);

  await settle(
    "setVerified",
    await registry.write.setVerified([deployer.account.address, true]),
  );

  console.log(`${stamp()} deploying DeferralVenue (constructor calls NoxCompute)...`);
  const venue = await viem.deployContract(
    "DeferralVenue",
    [registry.address, deployer.account.address],
  );
  console.log(`${stamp()}   ${venue.address}`);
  console.log(`${stamp()}   on-chain Nox calls work (toEuint256 did not revert)`);

  // ---- 2. encrypt an input through the gateway ---------------------------
  console.log(`\n${stamp()} building handle client...`);
  const handleClient = await createViemHandleClient(deployer as any);

  console.log(`${stamp()} encrypting ${SECRET} for ${venue.address}...`);
  const { handle, handleProof } = await handleClient.encryptInput(SECRET, "uint256", venue.address);
  console.log(`${stamp()}   handle ${handle}`);
  console.log(`${stamp()}   proof  ${handleProof.length} chars`);

  // ---- 3. transact with it ----------------------------------------------
  // depositCash validates the proof on-chain, then does Nox.add(balance, amount)
  // and grants the depositor a viewer grant on the RESULT handle. That result is
  // what has to be computed off-chain.
  console.log(`\n${stamp()} depositCash (validates proof, then Nox.add)...`);
  const txHash = await venue.write.depositCash([handle, handleProof]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`${stamp()}   block ${receipt.blockNumber}, gas ${receipt.gasUsed}, tx ${txHash}`);

  const resultHandle = (await venue.read.escrowCash([deployer.account.address])) as `0x${string}`;
  console.log(`${stamp()}   result handle ${resultHandle}`);

  // ---- 4. can we even see the ACL? --------------------------------------
  try {
    const acl = await handleClient.viewACL(resultHandle);
    console.log(`${stamp()}   ACL ${JSON.stringify(acl)}`);
  } catch (e: any) {
    console.log(`${stamp()}   viewACL failed: ${e.message}`);
  }

  // ---- 5. the actual test: does a Runner resolve it? --------------------
  console.log(`\n${stamp()} polling for the computed value (timeout ${RESOLVE_TIMEOUT_MS / 1000}s)...`);
  console.log(`${stamp()} this is the part no on-chain check can prove.`);

  const deadline = Date.now() + RESOLVE_TIMEOUT_MS;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    try {
      const { value, solidityType } = await handleClient.decrypt(resultHandle);
      console.log(`\n${stamp()} DECRYPTED: ${value} (${solidityType})`);

      if (BigInt(value as bigint) === SECRET) {
        console.log(`\n=== TASK 0 PASSED on chain ${chainId} ===`);
        console.log(`The off-chain stack resolves handles here. Value round-tripped exactly.`);
        console.log(`Proceed with Task 1 on this chain.\n`);
        return;
      }

      // Resolution works, but the arithmetic disagrees. That is a far more
      // interesting result than a timeout — the stack is alive and the contract
      // logic is wrong.
      console.log(`\n=== TASK 0: STACK ALIVE, VALUE MISMATCH ===`);
      console.log(`expected ${SECRET}, got ${value}.`);
      console.log(`Infrastructure is fine; investigate depositCash / Nox.add semantics.\n`);
      process.exitCode = 1;
      return;
    } catch (e: any) {
      const pending = e instanceof NotYetComputedHandleError || /not yet computed/i.test(e.message ?? "");
      const unknown = e instanceof UnknownHandleError || /unknown handle/i.test(e.message ?? "");

      if (pending || unknown) {
        const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        console.log(`${stamp()}   attempt ${attempt}: ${pending ? "not yet computed" : "unknown to the indexer"} (${left}s left)`);
      } else {
        console.log(`${stamp()}   attempt ${attempt}: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  console.log(`\n=== TASK 0 FAILED on chain ${chainId} ===`);
  console.log(`The handle never resolved in ${RESOLVE_TIMEOUT_MS / 1000}s.`);
  console.log(`NoxCompute exists here, but no Runner appears to be serving this chain.`);
  console.log(`\nAction: switch every network target to Arbitrum Sepolia (421614) and re-run:`);
  console.log(`  VITE_CHAIN_ID=421614 npx hardhat run scripts/task0-liveness.ts --network arbitrumSepolia\n`);
  process.exitCode = 1;
}

main().catch((e: any) => {
  // viem dumps full calldata into the message, which buries the reason.
  console.error(`\n${stamp()} Task 0 aborted: ${e.details ?? e.shortMessage ?? e.message}`);
  if (e.cause?.details && e.cause.details !== e.details) console.error(`  cause: ${e.cause.details}`);
  process.exitCode = 1;
});
