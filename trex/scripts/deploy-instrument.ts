/**
 * Deploys ONE additional ERC-3643 instrument onto the existing Layer 1.
 *
 * Deliberately NOT a second run of deploy-trex.ts. That script stands up a whole
 * suite — registries, compliance, modules, identities — and a second suite would
 * give the new token its own IdentityRegistry. Every address already registered
 * for ACME30 would be unverified against it, the venue points at exactly one
 * registry, and the wrappers re-check that same one. Two registries is two
 * disconnected worlds.
 *
 * So the identity layer is REUSED and only the instrument-specific pieces are
 * new: a Token, its own ModularCompliance (compliance is bound one-to-one with a
 * token, so it cannot be shared), and the two plug-and-play modules. Anyone
 * already verified can hold the new instrument the moment it exists.
 *
 *   SYMBOL=AAPL.rwa NAME="Apple Inc. tokenised equity" \
 *     npx hardhat run scripts/deploy-instrument.ts --network sepolia
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const SUPPLY_LIMIT = ethers.parseUnits("1000000", 18);
const RESTRICTED_COUNTRY = 643; // same demo restriction as ACME30
const MINT_TO_MAKER = ethers.parseUnits("100000", 18);

async function main() {
  const symbol = process.env.SYMBOL;
  const name = process.env.NAME;
  if (!symbol || !name) throw new Error("set SYMBOL and NAME");

  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const maker = signers[1] ?? deployer;

  const dir = path.join(__dirname, "..", "..", "deployments");
  const trexFile = path.join(dir, `trex.${network.name}.json`);
  if (!fs.existsSync(trexFile)) throw new Error(`no Layer 1 record at ${trexFile}`);
  const d = JSON.parse(fs.readFileSync(trexFile, "utf8"));

  console.log(`network:   ${network.name}`);
  console.log(`deployer:  ${deployer.address}`);
  console.log(`reusing registry: ${d.identityRegistry}`);
  console.log(`instrument: ${symbol} — ${name}\n`);

  // Compliance binds to exactly one token (`bindToken` sets a single address),
  // so each instrument needs its own, with its own module instances.
  const compliance = await (await ethers.getContractFactory("ModularCompliance")).deploy();
  await compliance.waitForDeployment();
  await (await compliance.init()).wait();

  const countryModule = await (await ethers.getContractFactory("CountryRestrictModule")).deploy();
  await countryModule.waitForDeployment();
  await (await countryModule.initialize()).wait();

  const supplyModule = await (await ethers.getContractFactory("SupplyLimitModule")).deploy();
  await supplyModule.waitForDeployment();
  await (await supplyModule.initialize()).wait();

  await (await compliance.addModule(await countryModule.getAddress())).wait();
  await (await compliance.addModule(await supplyModule.getAddress())).wait();

  // Module config is onlyComplianceCall — route through callModuleFunction.
  await (
    await compliance.callModuleFunction(
      countryModule.interface.encodeFunctionData("addCountryRestriction", [RESTRICTED_COUNTRY]),
      await countryModule.getAddress(),
    )
  ).wait();
  await (
    await compliance.callModuleFunction(
      supplyModule.interface.encodeFunctionData("setSupplyLimit", [SUPPLY_LIMIT]),
      await supplyModule.getAddress(),
    )
  ).wait();

  const token = await (await ethers.getContractFactory("Token")).deploy();
  await token.waitForDeployment();
  await (
    await token.init(d.identityRegistry, await compliance.getAddress(), name, symbol, 18, ethers.ZeroAddress)
  ).wait();

  await (await compliance.bindToken(await token.getAddress())).wait();
  await (await token.addAgent(deployer.address)).wait();

  await (await token.unpause()).wait();
  await (await token.mint(maker.address, MINT_TO_MAKER)).wait();

  const tokenAddress = await token.getAddress();
  console.log(`Token              ${tokenAddress}`);
  console.log(`ModularCompliance  ${await compliance.getAddress()}`);
  console.log(`minted 100,000 ${symbol} to ${maker.address}`);

  d.instruments = d.instruments ?? {};
  d.instruments[symbol] = {
    name,
    token: tokenAddress,
    modularCompliance: await compliance.getAddress(),
    countryRestrictModule: await countryModule.getAddress(),
    supplyLimitModule: await supplyModule.getAddress(),
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(trexFile, JSON.stringify(d, null, 2));
  console.log(`\nwrote ${trexFile}`);
  console.log(`\nNEXT — wrap it: TOKEN=${tokenAddress} SYMBOL=${symbol} npx hardhat run scripts/deploy-instrument-wrapper.ts --network ${network.name}   (from ../nox)`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
