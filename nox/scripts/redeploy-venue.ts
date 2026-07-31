/**
 * Redeploys ONLY the venue, keeping Layer 1 and the wrappers.
 *
 * The tokens, the IdentityRegistry and the confidential wrappers are unchanged
 * by a venue upgrade, and re-running deploy.ts would replace all of them — new
 * wrapper addresses would need re-registering as holders, and every already
 * wrapped balance would be stranded behind the old contract.
 *
 * The previous venue address is kept in the record under `previousVenues`, since
 * its fills are real history that the new contract does not inherit: orders and
 * fills live in the venue's own arrays, so a redeploy starts an empty book.
 *
 *   npx hardhat run scripts/redeploy-venue.ts --network sepolia
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

  const recordPath = path.join(
    import.meta.dirname,
    "..",
    "..",
    "deployments",
    `venue.${networkName}.json`,
  );
  if (!fs.existsSync(recordPath)) throw new Error(`no deployment record at ${recordPath}`);
  const d = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  if (d.chainId !== chainId) throw new Error(`record is chain ${d.chainId}, connected to ${chainId}`);

  console.log(`chain     ${chainId}`);
  console.log(`deployer  ${deployer.account.address}`);
  console.log(`registry  ${d.identityRegistry}`);
  console.log(`auditor   ${d.auditor}`);
  console.log(`previous  ${d.venue}\n`);

  const venue = await viem.deployContract("DeferralVenue", [d.identityRegistry, d.auditor]);
  console.log(`DeferralVenue  ${venue.address}`);

  const paused = await venue.read.paused();
  console.log(`paused()       ${paused}   (proves the new ABI is live)`);

  d.previousVenues = [...(d.previousVenues ?? []), { address: d.venue, retiredAt: new Date().toISOString() }];
  d.venue = venue.address;
  d.venueDeployedAt = new Date().toISOString();
  d.priceScale = Number(await venue.read.PRICE_SCALE());
  d.lisDeferralSeconds = Number(await venue.read.LIS_DEFERRAL());

  // The new venue starts with an empty book, so every tag from the old one is
  // meaningless. Leaving them would map fresh order ids onto stale instruments.
  delete d.orderInstruments;
  delete d.fillInstruments;

  fs.writeFileSync(recordPath, JSON.stringify(d, null, 2));
  console.log(`\nupdated ${recordPath}`);
  console.log(`\nNEXT:`);
  console.log(`  1. set VITE_VENUE=${venue.address} in frontend/.env.local`);
  console.log(`  2. npx hardhat run scripts/seed-book.ts --network ${networkName}`);
  console.log(`  3. npx hardhat run scripts/verify-all.ts --network ${networkName}`);
}

main().catch((e: any) => {
  console.error(`\nfailed: ${e.details ?? e.shortMessage ?? e.message}`);
  process.exitCode = 1;
});
