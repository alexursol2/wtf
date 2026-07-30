import type { HardhatUserConfig } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";

import { loadEnv, accountsArray } from "./lib/env.js";

// .env lives at the repo root so one file serves both Hardhat projects.
loadEnv();

const RPC_URL = process.env.RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const ARB_RPC_URL = process.env.ARB_RPC_URL ?? "https://arbitrum-sepolia-rpc.publicnode.com";

// Signer order is DEPLOYER, MAKER, TAKER, AUDITOR — scripts index on this.
// The maker and taker MUST be distinct: filling your own order writes both
// sides of the cash transfer to one storage slot (see DeferralVenue.fill).
const accounts = accountsArray();

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViem],

  // Verified source is load-bearing for this project specifically: the whole
  // claim is auditable disclosure, and an unverified contract asks a reader to
  // take the disclosure logic on trust. `npm run verify:sepolia`.
  verify: {
    etherscan: {
      apiKey: process.env.ETHERSCAN_API_KEY ?? "",
    },
  },
  solidity: {
    version: "0.8.35",
    settings: {
      // fill() does not compile without viaIR — stack too deep. See CLAUDE.md.
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    // Local simulated chain, chainid 31337 — the id Nox.sol maps to its local
    // NoxCompute address. allowUnlimitedContractSize is required because the
    // NoxCompute artifact shipped in the npm package is built for production
    // (optimizer + viaIR) and exceeds EIP-170 as shipped; the test harness
    // deploys it verbatim rather than recompiling it.
    hardhat: {
      type: "edr-simulated",
      chainId: 31337,
      allowUnlimitedContractSize: true,
    },
    // Ethereum Sepolia — NoxCompute 0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF
    sepolia: {
      type: "http",
      chainId: 11155111,
      url: RPC_URL,
      accounts,
    },
    // Arbitrum Sepolia — NoxCompute 0xd464B198f06756a1d00be223634b85E0a731c229
    arbitrumSepolia: {
      type: "http",
      chainId: 421614,
      url: ARB_RPC_URL,
      accounts,
    },
  },
};

export default config;
