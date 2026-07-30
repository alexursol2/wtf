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

async function main() {
  const networkName = process.env.HARDHAT_NETWORK ?? "hardhat";
  const { viem, provider } = await network.connect(
    networkName === "hardhat" ? { network: "hardhat" } : undefined,
  );

  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  const chainId = await publicClient.getChainId();

  // Nox reverts "Nox: Unsupported chain" anywhere else — fail loudly here
  // instead of at the first encrypted operation.
  const SUPPORTED = [31337, 421614, 11155111];
  if (!SUPPORTED.includes(chainId)) {
    throw new Error(`chain ${chainId} has no NoxCompute deployment (need one of ${SUPPORTED})`);
  }

  const auditor = (process.env.AUDITOR ?? deployer.account.address) as `0x${string}`;
  let identityRegistry = process.env.IDENTITY_REGISTRY as `0x${string}` | undefined;
  let bondToken = process.env.BOND_TOKEN as `0x${string}` | undefined;

  console.log(`chainId:  ${chainId}`);
  console.log(`deployer: ${deployer.account.address}`);
  console.log(`auditor:  ${auditor}`);

  // On a local chain nothing lives at the SDK's hardcoded NoxCompute address,
  // so the venue constructor (which calls Nox.toEuint256) would revert. Stand
  // the contract up first. On testnet the real deployment is already there.
  if (chainId === 31337) {
    const { gateway } = await bootstrapNoxCompute(viem, provider);
    console.log(`NoxCompute (local)      installed, gateway ${gateway.address}`);
  }

  // On a local chain, stand in for Layer 1 so the venue is deployable without
  // running the Hardhat-2 sub-project. On testnet, Layer 1 is mandatory.
  if (!identityRegistry) {
    if (chainId !== 31337) {
      throw new Error("IDENTITY_REGISTRY is required on a live network — deploy T-REX first");
    }
    const mockRegistry = await viem.deployContract("MockIdentityRegistry");
    await mockRegistry.write.setVerified([deployer.account.address, true]);
    identityRegistry = mockRegistry.address;
    console.log(`MockIdentityRegistry    ${identityRegistry}  (local only)`);
  }

  if (!bondToken) {
    const mockBond = await viem.deployContract("MockERC20", ["Acme 2030 Senior Note", "ACME30", 18]);
    bondToken = mockBond.address;
    console.log(`MockERC20 (bond)        ${bondToken}  (local only)`);
  }

  // The cash leg is always a mock stablecoin — there is no real one to point at.
  const cashToken = await viem.deployContract("MockERC20", ["Mock Euro", "mEUR", 6]);
  console.log(`MockERC20 (cash)        ${cashToken.address}`);

  // Layer 2 — one wrapper per leg, same contract.
  const sharesWrapper = await viem.deployContract("ConfidentialWrapper", [bondToken, identityRegistry]);
  console.log(`ConfidentialWrapper/bond ${sharesWrapper.address}`);

  const cashWrapper = await viem.deployContract("ConfidentialWrapper", [cashToken.address, identityRegistry]);
  console.log(`ConfidentialWrapper/cash ${cashWrapper.address}`);

  // Layer 3 — the venue. Note the constructor builds PRICE_SCALE_ENC via
  // Nox.toEuint256, which is NOT pure: it calls NoxCompute. So this deployment
  // genuinely exercises the Nox stack, and will fail fast if the off-chain
  // services are not serving this chain.
  const venue = await viem.deployContract("DeferralVenue", [identityRegistry, auditor]);
  console.log(`DeferralVenue            ${venue.address}`);

  const out = {
    network: networkName,
    chainId,
    deployedAt: new Date().toISOString(),
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
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
