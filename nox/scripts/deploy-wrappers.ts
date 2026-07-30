/**
 * Redeploys ONLY the two confidential wrappers, leaving the venue alone.
 *
 * The venue accumulates real fills, and those prints are the demo. Redeploying
 * it to pick up an unrelated change to the wrapper would throw that away for no
 * reason, so wrapper changes get their own path.
 *
 * Each wrapper takes custody of a token, so it must be a verified holder of
 * record. Register the new addresses afterwards, from the trex sub-project:
 *   HOLDER=<addr> COUNTRY=250 npx hardhat run scripts/register-holder.ts --network sepolia
 *
 *   npx hardhat run scripts/deploy-wrappers.ts --network sepolia
 */
import { network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadEnv } from "../lib/env.js";

async function main() {
  loadEnv();
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const [deployer] = await viem.getWalletClients();

  const NETWORK_NAMES: Record<number, string> = {
    31337: "hardhat",
    421614: "arbitrumSepolia",
    11155111: "sepolia",
  };
  const networkName = NETWORK_NAMES[chainId] ?? `chain-${chainId}`;

  const recordPath = path.join(import.meta.dirname, "..", "..", "deployments", `venue.${networkName}.json`);
  if (!fs.existsSync(recordPath)) throw new Error(`no deployment record at ${recordPath}`);
  const d = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  if (d.chainId !== chainId) throw new Error(`record is chain ${d.chainId}, connected to ${chainId}`);

  console.log(`chain     ${chainId}`);
  console.log(`issuer    ${deployer.account.address}  (owner of both wrappers)`);
  console.log(`registry  ${d.identityRegistry}`);
  console.log(`\nprevious wrappers:`);
  console.log(`  bond  ${d.sharesWrapper}`);
  console.log(`  cash  ${d.cashWrapper}`);

  const sharesWrapper = await viem.deployContract("ConfidentialWrapper", [
    d.bondToken,
    d.identityRegistry,
  ]);
  console.log(`\nConfidentialWrapper/bond ${sharesWrapper.address}`);

  const cashWrapper = await viem.deployContract("ConfidentialWrapper", [
    d.cashToken,
    d.identityRegistry,
  ]);
  console.log(`ConfidentialWrapper/cash ${cashWrapper.address}`);

  d.sharesWrapper = sharesWrapper.address;
  d.cashWrapper = cashWrapper.address;
  d.wrappersDeployedAt = new Date().toISOString();
  fs.writeFileSync(recordPath, JSON.stringify(d, null, 2));
  console.log(`\nupdated ${recordPath}`);

  console.log(`\nNEXT — register both as verified holders (from ../trex):`);
  console.log(`  HOLDER=${sharesWrapper.address} COUNTRY=250 npx hardhat run scripts/register-holder.ts --network ${networkName}`);
  console.log(`  HOLDER=${cashWrapper.address} COUNTRY=250 npx hardhat run scripts/register-holder.ts --network ${networkName}`);
}

main().catch((e: any) => {
  console.error(`\nfailed: ${e.details ?? e.shortMessage ?? e.message}`);
  process.exitCode = 1;
});
