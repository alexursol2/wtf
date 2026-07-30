import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import { loadEnv, accountsArray } from "./env";

// .env lives at the repo root so a single file serves both Hardhat projects.
loadEnv();

const RPC_URL = process.env.RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";

// Signer order: DEPLOYER, MAKER, TAKER, AUDITOR. deploy-trex.ts indexes on it.
const accounts = accountsArray();

/**
 * T-REX sub-project. Hardhat 2 / solc 0.8.17 — this CANNOT share a project with
 * the Nox side (Hardhat 3 / solc 0.8.35). Deploy this first, capture the
 * IdentityRegistry + token addresses, and reference them by address from the
 * Nox sub-project.
 */
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.17",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "london",
    },
  },
  networks: {
    sepolia: {
      chainId: 11155111,
      url: RPC_URL,
      accounts,
    },
    arbitrumSepolia: {
      chainId: 421614,
      url: process.env.ARB_RPC_URL ?? "https://arbitrum-sepolia-rpc.publicnode.com",
      accounts,
    },
  },
};

export default config;
