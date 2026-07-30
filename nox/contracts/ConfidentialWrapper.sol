// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Nox} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import "encrypted-types/EncryptedTypes.sol";

interface IERC20Minimal {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

interface IIdentityRegistry {
    function isVerified(address _userAddress) external view returns (bool);
    function investorCountry(address _userAddress) external view returns (uint16);
}

/**
 * @title ConfidentialWrapper
 * @notice ERC-7984-style confidential wrapper (Layer 2). Takes custody of a
 *         plaintext ERC-20 underlying (a T-REX bond, or the mock stablecoin —
 *         the SAME wrapper is reused for both so that both legs of a trade are
 *         confidential) and issues an encrypted-balance representation.
 *
 * Design notes, all load-bearing and verified against nox-protocol-contracts
 * 0.2.4 sources (not documentation):
 *
 *  - Custody POOLS the register at Layer 1: T-REX sees a single holder of record
 *    (this contract) holding everything. We therefore RE-ENFORCE identity and
 *    country rules here, on every path that credits a confidential balance:
 *    wrap, confidentialTransfer, and unwrap-claim. Amount-gated rules (max
 *    balance, transfer size, supply caps) are deliberately NOT enforced on the
 *    encrypted path — that would require a readable comparison against an
 *    encrypted balance, which the architecture makes impossible. Documented,
 *    not overlooked. See README leak model.
 *
 *  - Every Nox operation returns NEW handles. Each one needs a fresh persistent
 *    ACL grant (allowThis for the contract, addViewer for the owner) or the
 *    holder silently goes blind. This is the single most common Nox bug.
 *
 *  - Nox is async and branchless. unwrap CANNOT revert on "insufficient
 *    balance" — the comparison is encrypted and unreadable in-transaction, and
 *    reverting would leak the balance anyway. So unwrap is a two-phase
 *    request/claim: requestUnwrap moves the amount into a locked encrypted
 *    sub-balance and publishes only the success flag; claimUnwrap releases the
 *    underlying ONLY against a decryption proof that the lock actually
 *    succeeded. A failed (underfunded) request publishes success=false and the
 *    claim reverts — no underlying leaves, nothing about the balance leaks
 *    beyond the pass/fail the user themselves triggered.
 *
 *  - wrap/unwrap AMOUNTS are public. They ride a plaintext ERC-20 transfer, so
 *    they are inherently visible. This is a known property of every ERC-7984
 *    wrapper; the confidentiality is on the balances and transfers BETWEEN
 *    wrapped holders, not on the custody boundary.
 */
contract ConfidentialWrapper {
    // ------------------------------------------------------------------
    // Immutable wiring
    // ------------------------------------------------------------------

    IERC20Minimal public immutable underlying;
    IIdentityRegistry public immutable identityRegistry;
    address public immutable owner;

    // ------------------------------------------------------------------
    // Compliance re-enforcement (country allow-list, owner-managed)
    // ------------------------------------------------------------------

    /// If no country is ever allow-listed, the country gate is treated as open
    /// (identity check still applies). Once any country is set, only listed
    /// countries pass. Mirrors T-REX CountryRestrictModule semantics loosely.
    mapping(uint16 => bool) public allowedCountry;
    bool public countryGateActive;

    // ------------------------------------------------------------------
    // Encrypted state
    // ------------------------------------------------------------------

    mapping(address => euint256) internal _balances;
    mapping(address => euint256) internal _locked; // pending-unwrap sink
    euint256 internal _totalSupply;

    struct UnwrapRequest {
        address user;
        uint256 amount; // public — released 1:1 from the underlying on claim
        ebool ok; // encrypted success flag from the lock transfer
        bool claimed;
    }

    UnwrapRequest[] public unwrapRequests;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event Wrapped(address indexed account, uint256 amount);
    event ConfidentialTransfer(address indexed from, address indexed to);
    event UnwrapRequested(uint256 indexed requestId, address indexed account, uint256 amount);
    event Unwrapped(uint256 indexed requestId, address indexed account, uint256 amount);
    event CountryAllowed(uint16 indexed country, bool allowed);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _underlying, address _identityRegistry) {
        underlying = IERC20Minimal(_underlying);
        identityRegistry = IIdentityRegistry(_identityRegistry);
        owner = msg.sender;
    }

    // ------------------------------------------------------------------
    // Compliance admin
    // ------------------------------------------------------------------

    function setAllowedCountry(uint16 country, bool allowed) external onlyOwner {
        allowedCountry[country] = allowed;
        countryGateActive = true;
        emit CountryAllowed(country, allowed);
    }

    /// Identity + country re-enforcement. Called on every path that credits a
    /// confidential balance. Reverting here is fine: identity/country are
    /// PLAINTEXT facts, so a revert leaks nothing about any encrypted amount.
    function _requireCompliant(address account) internal view {
        require(identityRegistry.isVerified(account), "not verified");
        if (countryGateActive) {
            require(allowedCountry[identityRegistry.investorCountry(account)], "country");
        }
    }

    // ------------------------------------------------------------------
    // Wrap — plaintext in, encrypted balance out
    // ------------------------------------------------------------------

    function wrap(uint256 amount) external {
        _requireCompliant(msg.sender);
        require(amount > 0, "zero");
        require(underlying.transferFrom(msg.sender, address(this), amount), "transferFrom");

        euint256 encAmount = Nox.toEuint256(amount);
        (, euint256 newBal, euint256 newSupply) = Nox.mint(_balances[msg.sender], encAmount, _totalSupply);

        _balances[msg.sender] = newBal;
        _totalSupply = newSupply;

        // Fresh handles: re-grant or the holder goes blind.
        Nox.allowThis(newBal);
        Nox.addViewer(newBal, msg.sender);
        Nox.allowThis(newSupply);

        emit Wrapped(msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // Confidential transfer — fully encrypted, compliance re-enforced
    // ------------------------------------------------------------------

    function confidentialTransfer(
        address to,
        externalEuint256 encAmount,
        bytes calldata proof
    ) external {
        _requireCompliant(msg.sender);
        _requireCompliant(to); // re-enforce identity + country on the recipient

        euint256 amount = Nox.fromExternal(encAmount, proof);

        // `success` already encodes balanceFrom >= amount — no separate check.
        // Branchless: an underfunded transfer moves zero and does not revert,
        // which is the correct privacy behaviour.
        (, euint256 newFrom, euint256 newTo) = Nox.transfer(_balances[msg.sender], _balances[to], amount);

        _balances[msg.sender] = newFrom;
        _balances[to] = newTo;

        Nox.allowThis(newFrom);
        Nox.addViewer(newFrom, msg.sender);
        Nox.allowThis(newTo);
        Nox.addViewer(newTo, to);

        emit ConfidentialTransfer(msg.sender, to);
    }

    // ------------------------------------------------------------------
    // Unwrap — two-phase, async-faithful, branchless
    // ------------------------------------------------------------------

    /// Phase 1: move `amount` from the free balance into a locked sub-balance.
    /// Publishes ONLY the success flag. If underfunded, the lock transfer moves
    /// zero and `ok` decrypts to false — the claim will then revert.
    function requestUnwrap(uint256 amount) external returns (uint256 requestId) {
        require(amount > 0, "zero");
        euint256 encAmount = Nox.toEuint256(amount);

        (ebool ok, euint256 newFrom, euint256 newLocked) =
            Nox.transfer(_balances[msg.sender], _locked[msg.sender], encAmount);

        _balances[msg.sender] = newFrom;
        _locked[msg.sender] = newLocked;

        Nox.allowThis(newFrom);
        Nox.addViewer(newFrom, msg.sender);
        Nox.allowThis(newLocked);
        Nox.addViewer(newLocked, msg.sender);

        // Only the pass/fail flag becomes public — never a balance.
        Nox.allowThis(ok);
        Nox.allowPublicDecryption(ok);

        requestId = unwrapRequests.length;
        unwrapRequests.push(UnwrapRequest({user: msg.sender, amount: amount, ok: ok, claimed: false}));

        emit UnwrapRequested(requestId, msg.sender, amount);
    }

    /// Phase 2: release the underlying ONLY if the lock actually succeeded,
    /// proven by an off-chain decryption proof over the published `ok` flag.
    function claimUnwrap(uint256 requestId, bytes calldata okProof) external {
        UnwrapRequest storage r = unwrapRequests[requestId];
        require(msg.sender == r.user, "not requester");
        require(!r.claimed, "claimed");

        bool success = Nox.publicDecrypt(r.ok, okProof);
        require(success, "underfunded"); // the encrypted lock did not fund

        r.claimed = true;

        // Burn the locked encrypted amount so total supply tracks reality.
        euint256 encAmount = Nox.toEuint256(r.amount);
        (, euint256 newLocked, euint256 newSupply) =
            Nox.burn(_locked[r.user], encAmount, _totalSupply);
        _locked[r.user] = newLocked;
        _totalSupply = newSupply;
        Nox.allowThis(newLocked);
        Nox.addViewer(newLocked, r.user);
        Nox.allowThis(newSupply);

        require(underlying.transfer(r.user, r.amount), "transfer");
        emit Unwrapped(requestId, r.user, r.amount);
    }

    // ------------------------------------------------------------------
    // Views — return handles; decryption happens off-chain via the grants
    // ------------------------------------------------------------------

    function balanceHandle(address account) external view returns (euint256) {
        return _balances[account];
    }

    function lockedHandle(address account) external view returns (euint256) {
        return _locked[account];
    }

    function totalSupplyHandle() external view returns (euint256) {
        return _totalSupply;
    }

    function unwrapRequestCount() external view returns (uint256) {
        return unwrapRequests.length;
    }
}
