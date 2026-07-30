/**
 * Deploys the full T-REX (ERC-3643) suite — Layer 1.
 *
 * The npm package ships no deploy scripts (only flatten.js in the repo), and no
 * test fixtures, so this is written from the contract sources directly.
 *
 * Two things worth knowing before reading:
 *
 *  1. `isVerified` returns true immediately when requiredClaimTopics is empty.
 *     We deploy with ZERO claim topics so the pipeline comes up green, then add
 *     the topic + claim in a second pass (--with-claims). Bring it up simple.
 *
 *  2. Module config functions are `onlyComplianceCall`, so they must be invoked
 *     through `compliance.callModuleFunction(callData, module)` — calling the
 *     module directly reverts. Both modules used here report
 *     isPlugAndPlay() == true, verified in source, so they bind with no presetting.
 *
 * Writes deployed addresses to ../deployments/<network>.json. The Nox
 * sub-project reads the IdentityRegistry address from there.
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const CLAIM_TOPIC_KYC = 7n; // arbitrary topic id; must match the issued claim
const SUPPLY_LIMIT = ethers.parseUnits("1000000", 18); // 1M bonds
const RESTRICTED_COUNTRY = 643; // ISO-3166 numeric; restricted for the demo

const WITH_CLAIMS = process.env.WITH_CLAIMS === "true";

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  // On a live testnet there is usually only one funded key. Fall back to the
  // deployer so the script works both locally and on Sepolia.
  const issuer = signers[1] ?? deployer;
  const maker = signers[2] ?? deployer;
  const taker = signers[3] ?? deployer;

  console.log(`network:  ${network.name}`);
  console.log(`deployer: ${deployer.address}`);

  // ---------------------------------------------------------------
  // Registries
  // ---------------------------------------------------------------
  const claimTopicsRegistry = await (await ethers.getContractFactory("ClaimTopicsRegistry")).deploy();
  await claimTopicsRegistry.waitForDeployment();
  await (await claimTopicsRegistry.init()).wait();

  const trustedIssuersRegistry = await (await ethers.getContractFactory("TrustedIssuersRegistry")).deploy();
  await trustedIssuersRegistry.waitForDeployment();
  await (await trustedIssuersRegistry.init()).wait();

  const identityRegistryStorage = await (await ethers.getContractFactory("IdentityRegistryStorage")).deploy();
  await identityRegistryStorage.waitForDeployment();
  await (await identityRegistryStorage.init()).wait();

  const identityRegistry = await (await ethers.getContractFactory("IdentityRegistry")).deploy();
  await identityRegistry.waitForDeployment();
  await (
    await identityRegistry.init(
      await trustedIssuersRegistry.getAddress(),
      await claimTopicsRegistry.getAddress(),
      await identityRegistryStorage.getAddress(),
    )
  ).wait();

  // The storage must trust the registry that writes into it.
  await (await identityRegistryStorage.bindIdentityRegistry(await identityRegistry.getAddress())).wait();

  console.log(`ClaimTopicsRegistry     ${await claimTopicsRegistry.getAddress()}`);
  console.log(`TrustedIssuersRegistry  ${await trustedIssuersRegistry.getAddress()}`);
  console.log(`IdentityRegistryStorage ${await identityRegistryStorage.getAddress()}`);
  console.log(`IdentityRegistry        ${await identityRegistry.getAddress()}`);

  // ---------------------------------------------------------------
  // Compliance + the two plug-and-play modules
  // ---------------------------------------------------------------
  const compliance = await (await ethers.getContractFactory("ModularCompliance")).deploy();
  await compliance.waitForDeployment();
  await (await compliance.init()).wait();

  const countryRestrictModule = await (await ethers.getContractFactory("CountryRestrictModule")).deploy();
  await countryRestrictModule.waitForDeployment();
  await (await countryRestrictModule.initialize()).wait();

  const supplyLimitModule = await (await ethers.getContractFactory("SupplyLimitModule")).deploy();
  await supplyLimitModule.waitForDeployment();
  await (await supplyLimitModule.initialize()).wait();

  await (await compliance.addModule(await countryRestrictModule.getAddress())).wait();
  await (await compliance.addModule(await supplyLimitModule.getAddress())).wait();

  // Module config is onlyComplianceCall — route through callModuleFunction.
  await (
    await compliance.callModuleFunction(
      countryRestrictModule.interface.encodeFunctionData("addCountryRestriction", [RESTRICTED_COUNTRY]),
      await countryRestrictModule.getAddress(),
    )
  ).wait();

  await (
    await compliance.callModuleFunction(
      supplyLimitModule.interface.encodeFunctionData("setSupplyLimit", [SUPPLY_LIMIT]),
      await supplyLimitModule.getAddress(),
    )
  ).wait();

  console.log(`ModularCompliance       ${await compliance.getAddress()}`);
  console.log(`CountryRestrictModule   ${await countryRestrictModule.getAddress()}`);
  console.log(`SupplyLimitModule       ${await supplyLimitModule.getAddress()}`);

  // ---------------------------------------------------------------
  // The token — a tokenized corporate bond, not equity
  // ---------------------------------------------------------------
  const token = await (await ethers.getContractFactory("Token")).deploy();
  await token.waitForDeployment();
  await (
    await token.init(
      await identityRegistry.getAddress(),
      await compliance.getAddress(),
      "Acme 2030 Senior Note",
      "ACME30",
      18,
      ethers.ZeroAddress, // onchainID of the token itself, optional
    )
  ).wait();

  await (await compliance.bindToken(await token.getAddress())).wait();
  await (await token.addAgent(deployer.address)).wait();
  await (await identityRegistry.addAgent(deployer.address)).wait();

  console.log(`Token                   ${await token.getAddress()}`);

  // ---------------------------------------------------------------
  // Claim issuer + claim topics (second pass only)
  // ---------------------------------------------------------------
  let claimIssuerAddress = ethers.ZeroAddress;
  if (WITH_CLAIMS) {
    const claimIssuer = await (await ethers.getContractFactory("ClaimIssuer")).deploy(issuer.address);
    await claimIssuer.waitForDeployment();
    claimIssuerAddress = await claimIssuer.getAddress();

    await (await claimTopicsRegistry.addClaimTopic(CLAIM_TOPIC_KYC)).wait();
    await (await trustedIssuersRegistry.addTrustedIssuer(claimIssuerAddress, [CLAIM_TOPIC_KYC])).wait();
    console.log(`ClaimIssuer             ${claimIssuerAddress}`);
    console.log(`claim topic ${CLAIM_TOPIC_KYC} registered — isVerified now requires a claim`);
  } else {
    console.log("claim topics: NONE — isVerified() returns true for any registered identity");
  }

  // ---------------------------------------------------------------
  // Identities. The wrapper gets one too: isVerified does not distinguish
  // an EOA from a contract, so registering a contract as holder is routine.
  // ---------------------------------------------------------------
  const identityFactory = await ethers.getContractFactory("Identity");

  async function deployIdentity(managementKey: string) {
    const id = await identityFactory.deploy(managementKey, false);
    await id.waitForDeployment();
    return await id.getAddress();
  }

  const makerIdentity = await deployIdentity(maker.address);
  await (await identityRegistry.registerIdentity(maker.address, makerIdentity, 250)).wait(); // FR

  const identities: Record<string, string> = { maker: makerIdentity };

  // Only register distinct addresses — on a single-key testnet run they collide.
  if (taker.address !== maker.address) {
    const takerIdentity = await deployIdentity(taker.address);
    await (await identityRegistry.registerIdentity(taker.address, takerIdentity, 276)).wait(); // DE
    identities.taker = takerIdentity;
  }

  console.log(`maker identity          ${makerIdentity}`);

  // ---------------------------------------------------------------
  // Mint the bond to the maker so there is something to wrap
  // ---------------------------------------------------------------
  await (await token.unpause()).wait();
  await (await token.mint(maker.address, ethers.parseUnits("100000", 18))).wait();
  console.log(`minted 100,000 ACME30 to ${maker.address}`);

  // ---------------------------------------------------------------
  // Persist addresses for the Nox sub-project
  // ---------------------------------------------------------------
  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    withClaims: WITH_CLAIMS,
    token: await token.getAddress(),
    identityRegistry: await identityRegistry.getAddress(),
    identityRegistryStorage: await identityRegistryStorage.getAddress(),
    claimTopicsRegistry: await claimTopicsRegistry.getAddress(),
    trustedIssuersRegistry: await trustedIssuersRegistry.getAddress(),
    modularCompliance: await compliance.getAddress(),
    countryRestrictModule: await countryRestrictModule.getAddress(),
    supplyLimitModule: await supplyLimitModule.getAddress(),
    claimIssuer: claimIssuerAddress,
    identities,
    accounts: {
      deployer: deployer.address,
      issuer: issuer.address,
      maker: maker.address,
      taker: taker.address,
    },
  };

  const dir = path.join(__dirname, "..", "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `trex.${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${file}`);
  console.log("\nNext: deploy the Nox side with IDENTITY_REGISTRY=" + out.identityRegistry);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
