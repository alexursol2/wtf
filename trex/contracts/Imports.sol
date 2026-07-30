// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

/**
 * @title Imports
 * @notice Compile-time shim. Hardhat only compiles sources under ./contracts,
 *         so this file pulls the T-REX (ERC-3643) v4.1.6 and ONCHAINID v2.2.1
 *         contracts we deploy into the artifact set. Nothing here is deployed
 *         itself.
 *
 *         T-REX is used UNMODIFIED — that is the whole point of the wrapper
 *         architecture. We add confidentiality on top without forking the
 *         token, which is literally the brief. Do not edit anything under
 *         node_modules/@tokenysolutions.
 *
 *         Modules: CountryRestrictModule and SupplyLimitModule are used because
 *         both report isPlugAndPlay() == true (verified in source). NOT
 *         MaxBalanceModule, which returns false and needs balance presetting
 *         before it can be bound.
 */

// Token
import "@tokenysolutions/t-rex/contracts/token/Token.sol";

// Registries
import "@tokenysolutions/t-rex/contracts/registry/implementation/IdentityRegistry.sol";
import "@tokenysolutions/t-rex/contracts/registry/implementation/IdentityRegistryStorage.sol";
import "@tokenysolutions/t-rex/contracts/registry/implementation/ClaimTopicsRegistry.sol";
import "@tokenysolutions/t-rex/contracts/registry/implementation/TrustedIssuersRegistry.sol";

// Compliance + the two plug-and-play modules
import "@tokenysolutions/t-rex/contracts/compliance/modular/ModularCompliance.sol";
import "@tokenysolutions/t-rex/contracts/compliance/modular/modules/CountryRestrictModule.sol";
import "@tokenysolutions/t-rex/contracts/compliance/modular/modules/SupplyLimitModule.sol";

// ONCHAINID — identities for the wrapper and the traders
import "@onchain-id/solidity/contracts/Identity.sol";
import "@onchain-id/solidity/contracts/ClaimIssuer.sol";
