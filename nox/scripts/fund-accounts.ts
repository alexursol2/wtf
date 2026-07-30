/**
 * Tops up the maker and taker from the deployer.
 *
 * Only the deployer is expected to be faucet-funded. The maker and taker need a
 * small amount to transact; the AUDITOR NEEDS NOTHING — it sends no
 * transactions, because decryption is an off-chain signed request to the
 * gateway, not an on-chain call.
 *
 * Idempotent: it tops each account up TO a target balance, so re-running is
 * safe and cheap. It refuses to spend the deployer below a reserve, because the
 * deployer carries the T-REX suite (~20M gas) plus redeploys.
 *
 * Override with env vars if needed:
 *   FUND_MAKER=0.03  FUND_TAKER=0.03  DEPLOYER_RESERVE=0.08
 *
 *   npx hardhat run scripts/fund-accounts.ts --network sepolia
 */
import { network } from "hardhat";
import { parseEther, formatEther } from "viem";
import { loadEnv, roleAddresses } from "../lib/env.js";

/** Target balances. Sized from measured gas: maker ~1M and taker ~0.92M per trade cycle. */
const TARGETS: Record<string, bigint> = {
  MAKER: parseEther(process.env.FUND_MAKER ?? "0.025"),
  TAKER: parseEther(process.env.FUND_TAKER ?? "0.025"),
  // AUDITOR deliberately absent — funding it would be waste.
};

async function main() {
  loadEnv();

  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const walletClients = await viem.getWalletClients();

  const deployer = walletClients[0];
  if (!deployer) throw new Error("no signers — is PRIVATE_KEY_DEPLOYER set in .env?");

  const addresses = roleAddresses();
  const reserve = parseEther(process.env.DEPLOYER_RESERVE ?? "0.06");

  const gasPrice = await publicClient.getGasPrice();
  let deployerBalance = await publicClient.getBalance({ address: deployer.account.address });

  console.log(`\ndeployer  ${deployer.account.address}`);
  console.log(`balance   ${formatEther(deployerBalance)} ETH`);
  console.log(`gas       ${Number(gasPrice) / 1e9} gwei`);
  console.log(`reserve   ${formatEther(reserve)} ETH (kept back for the T-REX deploy)\n`);

  // A plain value transfer is 21000 gas; leave room for it plus a little slack.
  const transferCost = 21_000n * gasPrice * 2n;

  for (const [role, target] of Object.entries(TARGETS)) {
    const to = addresses[role];
    if (!to) {
      console.log(`${role.padEnd(8)} no PRIVATE_KEY_${role} in .env — skipping`);
      continue;
    }
    if (to.toLowerCase() === deployer.account.address.toLowerCase()) {
      console.log(`${role.padEnd(8)} same address as deployer — skipping`);
      continue;
    }

    const current = await publicClient.getBalance({ address: to as `0x${string}` });
    if (current >= target) {
      console.log(`${role.padEnd(8)} ${to}  has ${formatEther(current)} ETH — already at target`);
      continue;
    }

    const topUp = target - current;

    if (deployerBalance - topUp - transferCost < reserve) {
      console.log(
        `${role.padEnd(8)} ${to}  SKIPPED — sending ${formatEther(topUp)} ETH would break the ` +
          `deployer reserve (${formatEther(reserve)} ETH). Fund the deployer from a faucet first.`,
      );
      continue;
    }

    const hash = await deployer.sendTransaction({ to: to as `0x${string}`, value: topUp });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    deployerBalance = await publicClient.getBalance({ address: deployer.account.address });

    console.log(
      `${role.padEnd(8)} ${to}  sent ${formatEther(topUp)} ETH  ` +
        `(block ${receipt.blockNumber}, tx ${hash.slice(0, 10)}…)`,
    );
  }

  console.log(`\nfinal balances:`);
  for (const [role, address] of Object.entries(addresses)) {
    const b = await publicClient.getBalance({ address: address as `0x${string}` });
    const note = role === "AUDITOR" ? "  (intentionally unfunded — sends no transactions)" : "";
    console.log(`  ${role.padEnd(8)} ${formatEther(b).padStart(12)} ETH${note}`);
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
