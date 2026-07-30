/**
 * Deploys Layers 2 and 3 — the confidential wrappers and the RFQ venue.
 *
 * Run the T-REX sub-project's deploy script FIRST, then pass its
 * IdentityRegistry address in. The two sub-projects cannot share a Hardhat
 * install (Hardhat 2 / solc 0.8.17 vs Hardhat 3 / solc 0.8.35), so Layer 1 is
 * referenced purely by address.
 *
 *   IDENTITY_REGISTRY=0x...  the T-REX IdentityRegistry (required)
 *   BOND_TOKEN=0x...         the T-REX token; if omitted a MockERC20 is deployed
 *   AUDITOR=0x...            the regulator address; defaults to the deployer
 *
 * Both legs are wrapped. A public payment leg would leak the price and void the
 * whole design, so the SAME wrapper contract is deployed twice — once for the
 * bond, once for the cash.
 *
 * Usage:
 *   IDENTITY_REGISTRY=0x.. npx hardhat run scripts/deploy.ts --network sepolia
 */
import { network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { bootstrapNoxCompute } from "../lib/nox-local.js";
import { loadEnv, auditorAddress } from "../lib/env.js";

async function main() {
  loadEnv();

  // Bare connect() honours the --network flag. Do NOT branch on
  // process.env.HARDHAT_NETWORK: Hardhat 3 does not set it, so reading it makes
  // `--network sepolia` silently deploy to the local chain instead.
  const { viem, provider } = await network.connect();

  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  const chainId = await publicClient.getChainId();

  // Name the deployment record after the chain we actually reached, not after a
  // flag we were told about.
  const NETWORK_NAMES: Record<number, string> = {
    31337: "hardhat",
    421614: "arbitrumSepolia",
    11155111: "sepolia",
  };
  const networkName = NETWORK_NAMES[chainId] ?? `chain-${chainId}`;

  // Nox reverts "Nox: Unsupported chain" anywhere else — fail loudly here
  // instead of at the first encrypted operation.
  const SUPPORTED = [31337, 421614, 11155111];
  if (!SUPPORTED.includes(chainId)) {
    throw new Error(`chain ${chainId} has no NoxCompute deployment (need one of ${SUPPORTED})`);
  }

  const auditor = (auditorAddress() ?? deployer.account.address) as `0x${string}`;

  // Prefer the recorded Layer 1 deployment over env vars: it is written by
  // deploy-trex.ts and is therefore guaranteed to describe this same chain.
  //
  // Skipped on a local chain, where each run gets a fresh chain and any recorded
  // address is already dead — pointing the wrappers at a registry that no longer
  // has code would fail confusingly, well after this script.
  const trexRecord = path.join(import.meta.dirname, "..", "..", "deployments", `trex.${networkName}.json`);
  let trex: any;
  if (chainId !== 31337 && fs.existsSync(trexRecord)) {
    trex = JSON.parse(fs.readFileSync(trexRecord, "utf8"));
    if (trex.chainId !== undefined && trex.chainId !== chainId) {
      throw new Error(
        `${trexRecord} records chain ${trex.chainId} but we are on ${chainId} — redeploy Layer 1`,
      );
    }
  }

  let identityRegistry = (process.env.IDENTITY_REGISTRY || trex?.identityRegistry) as
    | `0x${string}`
    | undefined;
  let bondToken = (process.env.BOND_TOKEN || trex?.token) as `0x${string}` | undefined;

  console.log(`chainId:  ${chainId}`);
  console.log(`deployer: ${deployer.account.address}`);
  console.log(`auditor:  ${auditor}`);
  if (trex) console.log(`layer 1:  ${trexRecord.split(/[\\/]/).pop()} (real T-REX, no mocks)`);
  if (auditor === deployer.account.address) {
    console.log(`  NOTE: auditor == deployer. Set PRIVATE_KEY_AUDITOR for a distinct regulator.`);
  }

  // On a local chain nothing lives at the SDK's hardcoded NoxCompute address,
  // so the venue constructor (which calls Nox.toEuint256) would revert. Stand
  // the contract up first. On testnet the real deployment is already there.
  if (chainId === 31337) {
    const { gateway } = await bootstrapNoxCompute(viem, provider);
    console.log(`NoxCompute (local)      installed, gateway ${gateway.address}`);
  }

  // Read the nonce AFTER the local bootstrap, which spends several itself.
  // Public RPCs report stale nonces immediately after a send, which surfaces as
  // "nonce too low" or "replacement transaction underpriced" on the following
  // transaction, so track it locally and pass it explicitly from here on.
  let nonce = await publicClient.getTransactionCount({
    address: deployer.account.address,
    blockTag: "pending",
  });
  const n = () => ({ nonce: nonce++ });

  // On a local chain, stand in for Layer 1 so the venue is deployable without
  // running the Hardhat-2 sub-project. On testnet, Layer 1 is mandatory.
  if (!identityRegistry) {
    if (chainId !== 31337) {
      throw new Error("IDENTITY_REGISTRY is required on a live network — deploy T-REX first");
    }
    const mockRegistry = await viem.deployContract("MockIdentityRegistry", [], n());
    await mockRegistry.write.setVerified([deployer.account.address, true], n());
    identityRegistry = mockRegistry.address;
    console.log(`MockIdentityRegistry    ${identityRegistry}  (local only)`);
  }

  if (!bondToken) {
    const mockBond = await viem.deployContract(
      "MockERC20",
      ["Acme 2030 Senior Note", "ACME30", 18],
      n(),
    );
    bondToken = mockBond.address;
    console.log(`MockERC20 (bond)        ${bondToken}  (local only)`);
  }

  // The cash leg is always a mock stablecoin — there is no real euro to point
  // at. The BOND, however, is the real ERC-3643 token on a live chain.
  const cashToken = await viem.deployContract("MockERC20", ["Mock Euro", "mEUR", 6], n());
  console.log(`MockERC20 (cash)        ${cashToken.address}`);

  // Layer 2 — one wrapper per leg, same contract. Both legs must be
  // confidential: a public payment leg leaks the price and voids the design.
  const sharesWrapper = await viem.deployContract(
    "ConfidentialWrapper",
    [bondToken, identityRegistry],
    n(),
  );
  console.log(`ConfidentialWrapper/bond ${sharesWrapper.address}`);

  const cashWrapper = await viem.deployContract(
    "ConfidentialWrapper",
    [cashToken.address, identityRegistry],
    n(),
  );
  console.log(`ConfidentialWrapper/cash ${cashWrapper.address}`);

  // Layer 3 — the venue. Note the constructor builds PRICE_SCALE_ENC via
  // Nox.toEuint256, which is NOT pure: it calls NoxCompute. So this deployment
  // genuinely exercises the Nox stack, and will fail fast if the off-chain
  // services are not serving this chain.
  const venue = await viem.deployContract("DeferralVenue", [identityRegistry, auditor], n());
  console.log(`DeferralVenue            ${venue.address}`);

  const out = {
    network: networkName,
    chainId,
    deployedAt: new Date().toISOString(),
    usesMocks: !trex && chainId === 31337,
    identityRegistry,
    bondToken,
    cashToken: cashToken.address,
    sharesWrapper: sharesWrapper.address,
    cashWrapper: cashWrapper.address,
    venue: venue.address,
    auditor,
    priceScale: Number(await venue.read.PRICE_SCALE()),
    lisDeferralSeconds: Number(await venue.read.LIS_DEFERRAL()),
  };

  const dir = path.join(import.meta.dirname, "..", "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `venue.${networkName}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${file}`);

  if (chainId !== 31337) {
    // Each wrapper takes custody of the T-REX token, so it has to be a verified
    // holder of record — but its address only exists now, after Layer 1 was
    // deployed. Close the loop from the T-REX sub-project.
    console.log(`\nNEXT — register both wrappers as verified holders (from ../trex):`);
    console.log(`  HOLDER=${sharesWrapper.address} COUNTRY=250 npx hardhat run scripts/register-holder.ts --network ${networkName}`);
    console.log(`  HOLDER=${cashWrapper.address} COUNTRY=250 npx hardhat run scripts/register-holder.ts --network ${networkName}`);
    console.log(`\nTHEN — point the frontend at it:`);
    console.log(`  VITE_VENUE=${venue.address}`);
    console.log(`  VITE_SHARES_WRAPPER=${sharesWrapper.address}`);
    console.log(`  VITE_CASH_WRAPPER=${cashWrapper.address}`);
  }
}

main().catch((e: any) => {
  // viem embeds full calldata in the message, which buries the actual reason.
  console.error(`\ndeploy failed: ${e.details ?? e.shortMessage ?? e.message}`);
  process.exitCode = 1;
});
