// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

/**
 * @title MockIdentityRegistry
 * @notice Stands in for the T-REX IdentityRegistry on the local Nox stack, so
 *         Layers 2 and 3 are testable without running the Hardhat-2 T-REX
 *         sub-project. On testnet the real ERC-3643 IdentityRegistry is used
 *         and referenced by address — the interface is identical.
 *
 *         Note that the real `isVerified` does NOT distinguish an EOA from a
 *         contract (it only checks a registered identity plus claims), which is
 *         why registering the wrapper as a holder is routine rather than a hack.
 */
contract MockIdentityRegistry {
    mapping(address => bool) public verified;
    mapping(address => uint16) public country;

    function setVerified(address account, bool isOk) external {
        verified[account] = isOk;
    }

    function setCountry(address account, uint16 code) external {
        country[account] = code;
    }

    function isVerified(address _userAddress) external view returns (bool) {
        return verified[_userAddress];
    }

    function investorCountry(address _userAddress) external view returns (uint16) {
        return country[_userAddress];
    }
}
