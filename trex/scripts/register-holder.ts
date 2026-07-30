/**
 * Registers an address as a verified holder in the T-REX IdentityRegistry:
 * deploys an ONCHAINID for it, then registers that identity with a country.
 *
 * This exists because of an ordering problem in the three-layer stack. The
 * confidential wrappers take CUSTODY of the T-REX token, so each one has to be a
 * verified holder of record — but a wrapper's address does not exist until Layer
 * 2 has been deployed, which happens after Layer 1. So the address has to be fed
 * back into Layer 1 afterwards, and that is what this script is for.
 *
 * Registering a CONTRACT as a holder is routine rather than a trick:
 * `isVerified` only checks for a registered identity plus the required claims,
 * and does not distinguish an EOA from a contract.
 *
 *   HOLDER=0x… COUNTRY=250 npx hardhat run scripts/register-holder.ts --network sepolia
 *
 * COUNTRY is an ISO-3166 numeric code and defaults to 250 (France). Do not use
 * 643, which the deploy script restricts via CountryRestrictModule.
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const holder = process.env.HOLDER;
  const country = Number(process.env.COUNTRY ?? 250);

  if (!holder || !ethers.isAddress(holder)) {
    throw new Error("set HOLDER to the address to register, e.g. HOLDER=0xabc…");
  }

  const deploymentsPath = path.join(__dirname, "..", "..", "deployments", `trex.${network.name}.json`);
  if (!fs.existsSync(deploymentsPath)) {
    throw new Error(`no deployment record at ${deploymentsPath} — run deploy-trex.ts first`);
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));

  const [deployer] = await ethers.getSigners();
  console.log(`network:  ${network.name}`);
  console.log(`agent:    ${deployer.address}`);
  console.log(`registry: ${deployment.identityRegistry}`);
  console.log(`holder:   ${holder}  (country ${country})`);

  const registry = await ethers.getContractAt("IdentityRegistry", deployment.identityRegistry);

  // registerIdentity is onlyAgent, so fail early with a clear message rather
  // than an opaque revert.
  if (!(await registry.isAgent(deployer.address))) {
    throw new Error(`${deployer.address} is not an agent on the IdentityRegistry`);
  }

  if (await registry.contains(holder)) {
    console.log(`\nalready registered — isVerified = ${await registry.isVerified(holder)}`);
    return;
  }

  // The holder itself cannot hold a management key if it is a contract without
  // key-management support, so the deployer keeps the management key. That is
  // fine here: the identity exists to satisfy the registry, and the wrapper
  // never needs to add claims to its own identity.
  const identity = await (await ethers.getContractFactory("Identity")).deploy(deployer.address, false);
  await identity.waitForDeployment();
  const identityAddress = await identity.getAddress();
  console.log(`\nONCHAINID deployed: ${identityAddress}`);

  await (await registry.registerIdentity(holder, identityAddress, country)).wait();
  console.log(`registered.`);

  const verified = await registry.isVerified(holder);
  console.log(`isVerified(${holder}) = ${verified}`);
  if (!verified) {
    console.log(
      "\nNOTE: false means required claim topics are set but this identity holds no claim. " +
        "Either issue the claim, or redeploy with WITH_CLAIMS=false to bring the pipeline up green first.",
    );
  }

  // Record it, so the deployment file stays an accurate description of chain state.
  deployment.registeredHolders = deployment.registeredHolders ?? {};
  deployment.registeredHolders[holder] = { identity: identityAddress, country, verified };
  fs.writeFileSync(deploymentsPath, JSON.stringify(deployment, null, 2));
  console.log(`\nupdated ${deploymentsPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
