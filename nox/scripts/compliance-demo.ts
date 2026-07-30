/**
 * The pooling problem, and what we actually do about it.
 *
 * This is the one real structural hole in the architecture, so it gets shown
 * rather than glossed. Taking custody means T-REX sees a SINGLE holder of
 * record — the wrapper — holding everything. Layer 1's compliance modules are
 * therefore evaluating rules against one aggregate address, and cannot tell one
 * beneficial holder from another inside it.
 *
 * The mitigation is to re-enforce identity and country INSIDE the confidential
 * layer, on every path that credits an encrypted balance. This script proves
 * that the re-enforcement is real by getting a transfer rejected on the
 * encrypted path.
 *
 * What it does NOT claim: amount-gated rules. Max balance, transfer size and
 * supply limits are not enforced here, because enforcing them would need a
 * readable comparison against an encrypted balance — which the architecture
 * deliberately makes impossible. See the README. We do not call
 * canTransfer(from, to, 0) and describe that as enforcement; a zero amount
 * passes every amount-gated module trivially.
 *
 *   npx hardhat run scripts/compliance-demo.ts --network sepolia
 */
import { network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { createViemHandleClient } from "@iexec-nox/handle";
import { formatUnits, parseUnits, type Hex } from "viem";
import { loadEnv, roleWalletClient } from "../lib/env.js";

const FRANCE = 250;
const GERMANY = 276;
const TRANSFER_AMOUNT = parseUnits("100", 18);

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const IR_ABI = [
  { name: "isVerified", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { name: "investorCountry", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint16" }] },
] as const;

async function main() {
  loadEnv();
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const [issuer, maker, taker] = await viem.getWalletClients();

  const d = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "..", "..", "deployments", "venue.sepolia.json"), "utf8"),
  );
  if (d.chainId !== chainId) throw new Error(`record is chain ${d.chainId}, connected to ${chainId}`);

  const wrapper = await viem.getContractAt("ConfidentialWrapper", d.sharesWrapper);

  const nonces = new Map<string, number>();
  for (const c of [issuer, maker]) {
    nonces.set(
      c.account.address,
      await publicClient.getTransactionCount({ address: c.account.address, blockTag: "pending" }),
    );
  }
  const n = (c: any) => {
    const cur = nonces.get(c.account.address)!;
    nonces.set(c.account.address, cur + 1);
    return { nonce: cur, account: c.account };
  };
  const settle = async (label: string, hash: Hex) => {
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${label} reverted`);
    console.log(`  ${label} (block ${r.blockNumber})`);
  };

  const country = (who: Hex) =>
    publicClient.readContract({
      address: d.identityRegistry,
      abi: IR_ABI,
      functionName: "investorCountry",
      args: [who],
    }) as Promise<number>;

  console.log(`\n=== 1. the pooling problem, stated plainly ===\n`);

  const wrapperBalance = (await publicClient.readContract({
    address: d.bondToken,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [d.sharesWrapper],
  })) as bigint;

  console.log(`  T-REX token   ${d.bondToken}`);
  console.log(`  wrapper holds ${formatUnits(wrapperBalance, 18)} ACME30 as a SINGLE holder of record`);
  console.log(`  wrapper addr  ${d.sharesWrapper}`);
  console.log(``);
  console.log(`  Layer 1 sees one address. Its CountryRestrictModule cannot tell one`);
  console.log(`  beneficial holder from another inside that balance. Compliance has been`);
  console.log(`  pooled around, not preserved. That is the honest position.`);

  console.log(`\n=== 2. the mitigation: re-enforce inside the confidential layer ===\n`);

  const makerCountry = await country(maker.account.address);
  const takerCountry = await country(taker.account.address);
  console.log(`  maker ${maker.account.address}  country ${makerCountry}`);
  console.log(`  taker ${taker.account.address}  country ${takerCountry}`);

  const gateActive = (await wrapper.read.countryGateActive()) as boolean;
  if (!gateActive || !(await wrapper.read.allowedCountry([FRANCE]))) {
    console.log(`\n  issuer activates the country gate: only ${FRANCE} (FR) may hold`);
    await settle(
      "setAllowedCountry(250, true)",
      await wrapper.write.setAllowedCountry([FRANCE, true], n(issuer)),
    );
  } else {
    console.log(`\n  country gate already active, ${FRANCE} allowed`);
  }
  console.log(`  allowed: FR=${await wrapper.read.allowedCountry([FRANCE])}  DE=${await wrapper.read.allowedCountry([GERMANY])}`);

  console.log(`\n=== 3. a confidential transfer to a restricted country ===\n`);

  // The AMOUNT is encrypted end to end — the gateway mints the handle and the
  // contract never sees a plaintext number. The rejection below is on identity
  // and country, which are PLAINTEXT facts, so reverting on them leaks nothing
  // about the amount.
  const hcMaker = await createViemHandleClient(roleWalletClient("MAKER", chainId) as any);
  const { handle, handleProof } = await hcMaker.encryptInput(
    TRANSFER_AMOUNT,
    "uint256",
    d.sharesWrapper,
  );
  console.log(`  maker encrypts ${formatUnits(TRANSFER_AMOUNT, 18)} -> handle ${handle.slice(0, 18)}…`);
  console.log(`  attempting confidentialTransfer(maker -> taker) ...`);

  try {
    await publicClient.simulateContract({
      address: d.sharesWrapper,
      abi: (wrapper as any).abi,
      functionName: "confidentialTransfer",
      args: [taker.account.address, handle, handleProof],
      account: maker.account,
    });
    console.log(`\n  UNEXPECTED: the transfer was permitted.`);
    process.exitCode = 1;
    return;
  } catch (e: any) {
    // viem puts the revert string on cause.reason; shortMessage only says that
    // it reverted. The reason is the whole point here, so dig it out.
    const reason: string =
      e.cause?.reason ?? e.cause?.shortMessage ?? e.shortMessage ?? e.message ?? "";
    const full = `${reason} ${e.message ?? ""}`;
    const rejected = /country/i.test(full);

    console.log(`\n  REJECTED — revert reason: "${e.cause?.reason ?? reason.split("\n")[0]}"`);
    if (!rejected) {
      console.log(`  (expected a country rejection — check the gate configuration)`);
      process.exitCode = 1;
      return;
    }
  }

  console.log(`\n  The recipient's country was checked INSIDE the confidential layer, on a`);
  console.log(`  transfer whose amount is a ciphertext handle. Layer 1 could not have done`);
  console.log(`  this: it sees only the wrapper.`);

  console.log(`\n=== 4. and a transfer to an allowed country is permitted ===\n`);

  const { handle: h2, handleProof: p2 } = await hcMaker.encryptInput(
    TRANSFER_AMOUNT,
    "uint256",
    d.sharesWrapper,
  );
  try {
    await publicClient.simulateContract({
      address: d.sharesWrapper,
      abi: (wrapper as any).abi,
      functionName: "confidentialTransfer",
      args: [maker.account.address, h2, p2], // FR -> FR
      account: maker.account,
    });
    console.log(`  PERMITTED: FR -> FR passes the same gate.`);
    console.log(`  So the rejection above is the rule working, not the path being broken.`);
  } catch (e: any) {
    console.log(`  unexpected rejection on the allowed path: ${e.shortMessage ?? e.message}`);
    process.exitCode = 1;
  }

  console.log(`\n=== what this does NOT prove ===\n`);
  console.log(`  Amount-gated rules — max balance, max transfer size, supply limits — are`);
  console.log(`  NOT enforced on the encrypted path. Doing so would require a readable`);
  console.log(`  comparison against an encrypted balance, which is exactly what the`);
  console.log(`  architecture prevents. A branchless select(withinCap, amount, ZERO) would`);
  console.log(`  restore them by settling violations to zero rather than reverting; we did`);
  console.log(`  not ship it. Documented limitation, not an oversight.\n`);
}

main().catch((e: any) => {
  console.error(`\nfailed: ${e.details ?? e.shortMessage ?? e.message}`);
  process.exitCode = 1;
});
