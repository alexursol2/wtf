/**
 * Wraps one additional instrument — Layer 2 for a token deployed by
 * ../trex/scripts/deploy-instrument.ts.
 *
 * The wrapper takes custody, so it holds the token itself and must therefore be
 * a verified holder of record in the SAME IdentityRegistry the token points at.
 * That registration is a separate transaction from the trex sub-project; the
 * command is printed at the end rather than assumed.
 *
 *   TOKEN=0x... SYMBOL=AAPL.rwa npx hardhat run scripts/deploy-instrument-wrapper.ts --network sepolia
 */
import { network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadEnv } from "../lib/env.js";

async function main() {
  loadEnv();
  const token = process.env.TOKEN;
  const symbol = process.env.SYMBOL;
  if (!token || !symbol) throw new Error("set TOKEN and SYMBOL");

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

  console.log(`chain      ${chainId}`);
  console.log(`issuer     ${deployer.account.address}`);
  console.log(`registry   ${d.identityRegistry}`);
  console.log(`instrument ${symbol} @ ${token}\n`);

  const wrapper = await viem.deployContract("ConfidentialWrapper", [
    token as `0x${string}`,
    d.identityRegistry as `0x${string}`,
  ]);
  console.log(`ConfidentialWrapper  ${wrapper.address}`);

  d.instrumentWrappers = d.instrumentWrappers ?? {};
  d.instrumentWrappers[symbol] = { token, wrapper: wrapper.address, deployedAt: new Date().toISOString() };
  fs.writeFileSync(recordPath, JSON.stringify(d, null, 2));
  console.log(`\nupdated ${recordPath}`);

  console.log(`\nNEXT — register the wrapper as a verified holder (from ../trex):`);
  console.log(
    `  HOLDER=${wrapper.address} COUNTRY=250 npx hardhat run scripts/register-holder.ts --network ${networkName}`,
  );
}

main().catch((e: any) => {
  console.error(`\nfailed: ${e.details ?? e.shortMessage ?? e.message}`);
  process.exitCode = 1;
});
