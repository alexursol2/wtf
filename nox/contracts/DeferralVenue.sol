// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Nox} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import "encrypted-types/EncryptedTypes.sol";

interface IIdentityRegistry {
    function isVerified(address _userAddress) external view returns (bool);
}

/**
 * @title DeferralVenue
 * @notice RFQ venue with MiFIR-modelled post-trade disclosure.
 *
 * Design notes that are load-bearing (all verified against
 * the published nox-protocol-contracts 0.2.4 sources, not documentation):
 *
 *  - `Nox.select` has NO ebool overload. Conjunction of ebools is impossible.
 *    We gate the *quantity* through nested selects; zero propagates downstream.
 *
 *  - `Nox.transfer(from, to, amount)` is a VALUE-level primitive. It does not
 *    take addresses and does not call a token contract. It returns three NEW
 *    handles: (success, newFrom, newTo). Every one of them needs a fresh ACL
 *    grant or the owner can no longer decrypt their own balance.
 *
 *  - Its `success` flag already encodes "balanceFrom >= amount", so it doubles
 *    as the funding check. No separate safeSub needed.
 *
 *  - Escrow lives in THIS contract as raw handles. The fill path never calls
 *    the wrapper, so there is no cross-contract ACL propagation on the hot
 *    path. Only deposit/withdraw touch the ERC-7984 wrapper.
 *
 *  - Publication is irreversible (no removeViewer, no persistent disallow).
 *    Nothing is published inside fill(); see reportTrade().
 */
contract DeferralVenue {
    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    enum OrderState {
        Open,
        PendingResolution,
        Cancelled
    }

    enum Bucket {
        Standard,
        LargeInScale
    }

    struct Order {
        address maker;
        euint256 qtyRemaining; // escrowed shares, long-lived handle
        euint256 price; // scaled by PRICE_SCALE
        uint64 expiry;
        OrderState state;
    }

    struct Fill {
        address maker; // the reporting entity
        address taker;
        euint256 qty;
        euint256 price; // SNAPSHOT handle, never the live order's
        Bucket bucket;
        uint64 volumeDeferredUntil;
        bool reported;
        bool volumePublished;
    }

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    uint256 public constant PRICE_SCALE = 1e4; // 98.7500 -> 987500
    uint64 public constant LIS_DEFERRAL = 90; // demo value; caption on screen

    IIdentityRegistry public immutable identityRegistry;
    address public immutable auditor;

    /// Built once at deploy. toEuint256 is NOT pure - it calls NoxCompute.
    euint256 internal priceScaleEnc;

    mapping(address => euint256) public escrowShares;
    mapping(address => euint256) public escrowCash;

    Order[] public orders;
    Fill[] public fills;

    /// Emergency compliance controls, held by the auditor alone.
    ///
    /// Both act on PLAINTEXT state on purpose. A breaker that operated on
    /// ciphertext would be unusable: the contract cannot read an encrypted
    /// value, so it could not decide anything from one, and gating settlement
    /// on an encrypted flag would silently zero trades instead of stopping
    /// them - the failure mode this venue works hardest to avoid. Pausing is a
    /// public act, and it should be: a halted venue is not a secret.
    ///
    /// Note the limit, which is inherent rather than an omission. Pausing stops
    /// NEW orders and fills. It cannot reverse a settled trade: settlement has
    /// already moved encrypted balances through Nox.transfer, and there is no
    /// un-transfer. Freezing a fill therefore blocks its disclosure, not its
    /// economics.
    bool public paused;
    mapping(uint256 => bool) public fillFrozen;

    event OrderPosted(uint256 indexed id, address indexed maker, uint64 expiry);
    event FillRecorded(uint256 indexed fillId, uint256 indexed orderId, address indexed taker, Bucket bucket);
    event TradeReported(uint256 indexed fillId);
    event VolumePublished(uint256 indexed fillId);
    event PausedSet(bool value);
    event FillFrozenSet(uint256 indexed fillId, bool value);

    modifier onlyAuditor() {
        require(msg.sender == auditor, "not auditor");
        _;
    }

    constructor(address _identityRegistry, address _auditor) {
        identityRegistry = IIdentityRegistry(_identityRegistry);
        auditor = _auditor;
        priceScaleEnc = Nox.toEuint256(PRICE_SCALE);
        Nox.allowThis(priceScaleEnc);
    }

    // ------------------------------------------------------------------
    // Circuit breakers
    // ------------------------------------------------------------------

    function setPaused(bool value) external onlyAuditor {
        paused = value;
        emit PausedSet(value);
    }

    function setFillFrozen(uint256 fillId, bool value) external onlyAuditor {
        require(fillId < fills.length, "no such fill");
        fillFrozen[fillId] = value;
        emit FillFrozenSet(fillId, value);
    }

    // ------------------------------------------------------------------
    // Enumeration
    // ------------------------------------------------------------------

    /// Solidity generates no length getter for a public array, and enumerating
    /// via events is not viable: hosted RPCs cap eth_getLogs at a narrow block
    /// range (Alchemy's free tier allows 10 blocks), and the Nox subgraph
    /// indexes handles rather than this contract's events. So the frontend
    /// pages by index off these counts instead of scanning logs.

    function ordersCount() external view returns (uint256) {
        return orders.length;
    }

    function fillsCount() external view returns (uint256) {
        return fills.length;
    }

    // ------------------------------------------------------------------
    // Escrow
    // ------------------------------------------------------------------

    function depositCash(externalEuint256 encAmount, bytes calldata proof) external {
        require(identityRegistry.isVerified(msg.sender), "not verified");
        euint256 amount = Nox.fromExternal(encAmount, proof);
        euint256 updated = Nox.add(escrowCash[msg.sender], amount);
        escrowCash[msg.sender] = updated;
        // Fresh handle: re-grant every time or the depositor goes blind.
        Nox.allowThis(updated);
        Nox.addViewer(updated, msg.sender);
    }

    function depositShares(externalEuint256 encAmount, bytes calldata proof) external {
        require(identityRegistry.isVerified(msg.sender), "not verified");
        euint256 amount = Nox.fromExternal(encAmount, proof);
        euint256 updated = Nox.add(escrowShares[msg.sender], amount);
        escrowShares[msg.sender] = updated;
        Nox.allowThis(updated);
        Nox.addViewer(updated, msg.sender);
    }

    // ------------------------------------------------------------------
    // Maker side
    // ------------------------------------------------------------------

    function postAsk(
        externalEuint256 encQty,
        externalEuint256 encPrice,
        bytes calldata qtyProof,
        bytes calldata priceProof,
        uint64 expiry
    ) external returns (uint256 id) {
        require(!paused, "paused");
        require(identityRegistry.isVerified(msg.sender), "not verified");
        require(expiry > block.timestamp, "expiry in past");

        euint256 qty = Nox.fromExternal(encQty, qtyProof);
        euint256 price = Nox.fromExternal(encPrice, priceProof);

        // Move shares from the maker's free escrow into the order.
        // success is ignored on purpose: an underfunded maker simply escrows
        // zero, and the order settles for zero. Reverting would leak.
        (, euint256 newMakerShares, euint256 escrowed) = Nox.transfer(escrowShares[msg.sender], euint256.wrap(0), qty);

        escrowShares[msg.sender] = newMakerShares;

        id = orders.length;
        orders.push(
            Order({
                maker: msg.sender,
                qtyRemaining: escrowed,
                price: price,
                expiry: expiry,
                state: OrderState.Open
            })
        );

        Nox.allowThis(newMakerShares);
        Nox.addViewer(newMakerShares, msg.sender);
        Nox.allowThis(escrowed);
        Nox.addViewer(escrowed, msg.sender);
        Nox.allowThis(price);
        Nox.addViewer(price, msg.sender);

        emit OrderPosted(id, msg.sender, expiry);
    }

    // ------------------------------------------------------------------
    // Taker side - branchless
    // ------------------------------------------------------------------

    function fill(
        uint256 id,
        externalEuint256 encBid,
        externalEuint256 encQty,
        bytes calldata bidProof,
        bytes calldata qtyProof,
        Bucket declaredBucket
    ) external {
        require(!paused, "paused");
        Order storage o = orders[id];
        require(o.state == OrderState.Open, "not fillable");
        require(block.timestamp < o.expiry, "expired");
        require(identityRegistry.isVerified(msg.sender), "not verified");

        // A self-fill is not merely a wash trade, it is a balance bug: with
        // msg.sender == o.maker, escrowCash[msg.sender] and escrowCash[o.maker]
        // read the SAME handle, and the two writes below land in the SAME
        // storage slot. The second wins, so the debit is discarded and the
        // filler ends up credited. Reject it in plaintext — the identity of the
        // counterparty is public anyway, so this require leaks nothing.
        require(msg.sender != o.maker, "self fill");

        euint256 bid = Nox.fromExternal(encBid, bidProof);
        euint256 wanted = Nox.fromExternal(encQty, qtyProof);

        ebool crosses = Nox.ge(bid, o.price);
        ebool wantsLess = Nox.lt(wanted, o.qtyRemaining);
        euint256 fillQty = Nox.select(wantsLess, wanted, o.qtyRemaining);

        (ebool noOverflow, euint256 gross) = Nox.safeMul(fillQty, o.price);
        euint256 need = Nox.div(gross, priceScaleEnc);

        // Gate BEFORE moving cash. If we transferred first and gated after,
        // a non-crossing fill would move money without shares.
        euint256 qtyGated = Nox.select(crosses, Nox.select(noOverflow, fillQty, euint256.wrap(0)), euint256.wrap(0));
        euint256 needGated = Nox.select(crosses, Nox.select(noOverflow, need, euint256.wrap(0)), euint256.wrap(0));

        // Cash leg. `paid` IS the funding check - no separate safeSub.
        (ebool paid, euint256 newTakerCash, euint256 newMakerCash) =
            Nox.transfer(escrowCash[msg.sender], escrowCash[o.maker], needGated);

        // A zero transfer succeeds, so `paid` is true for gated-out fills -
        // but qtyGated is already zero there, so qtyOut stays zero.
        euint256 qtyOut = Nox.select(paid, qtyGated, euint256.wrap(0));

        // Shares leg, out of the order's own escrow.
        (, euint256 newRemaining, euint256 newTakerShares) =
            Nox.transfer(o.qtyRemaining, escrowShares[msg.sender], qtyOut);

        escrowCash[msg.sender] = newTakerCash;
        escrowCash[o.maker] = newMakerCash;
        escrowShares[msg.sender] = newTakerShares;
        o.qtyRemaining = newRemaining;
        o.state = OrderState.PendingResolution;

        // Snapshot the price into a fresh handle. reportTrade publishes this
        // one, never o.price - publication is permanent and the order may
        // still be resting.
        euint256 snapPrice = Nox.add(o.price, euint256.wrap(0));

        uint256 fillId = fills.length;
        fills.push(
            Fill({
                maker: o.maker,
                taker: msg.sender,
                qty: qtyOut,
                price: snapPrice,
                bucket: declaredBucket,
                volumeDeferredUntil: 0,
                reported: false,
                volumePublished: false
            })
        );

        // ---- ACL. Every handle above is NEW. Miss one and it goes dead. ----
        Nox.allowThis(newTakerCash);
        Nox.allowThis(newMakerCash);
        Nox.allowThis(newTakerShares);
        Nox.allowThis(newRemaining);
        Nox.allowThis(qtyOut);
        Nox.allowThis(snapPrice); // required: allowPublicDecryption is onlyAllowed

        Nox.addViewer(newTakerCash, msg.sender);
        Nox.addViewer(newMakerCash, o.maker);
        Nox.addViewer(newTakerShares, msg.sender);
        Nox.addViewer(newRemaining, o.maker);
        Nox.addViewer(qtyOut, msg.sender);
        Nox.addViewer(qtyOut, o.maker);
        Nox.addViewer(qtyOut, auditor); // regulator sees volume from block 1

        emit FillRecorded(fillId, id, msg.sender, declaredBucket);
    }

    // ------------------------------------------------------------------
    // Disclosure - a separate act by the reporting entity
    // ------------------------------------------------------------------

    function reportTrade(uint256 fillId) external {
        Fill storage f = fills[fillId];
        require(!fillFrozen[fillId], "frozen");
        require(msg.sender == f.maker, "reporting entity");
        require(!f.reported, "reported");
        f.reported = true;
        f.volumeDeferredUntil = f.bucket == Bucket.LargeInScale
            ? uint64(block.timestamp) + LIS_DEFERRAL
            : uint64(block.timestamp);
        Nox.allowPublicDecryption(f.price);
        emit TradeReported(fillId);
    }

    function publishVolume(uint256 fillId) external {
        Fill storage f = fills[fillId];
        require(!fillFrozen[fillId], "frozen");
        require(f.reported, "not reported");
        require(!f.volumePublished, "published");
        require(block.timestamp >= f.volumeDeferredUntil, "deferred");
        f.volumePublished = true;
        Nox.allowPublicDecryption(f.qty);
        emit VolumePublished(fillId);
    }

    // ------------------------------------------------------------------
    // Cancellation
    // ------------------------------------------------------------------

    function cancel(uint256 id) external {
        Order storage o = orders[id];
        require(msg.sender == o.maker, "not maker");
        require(o.state == OrderState.Open, "pending or cancelled");
        o.state = OrderState.Cancelled;

        (, euint256 newRemaining, euint256 newMakerShares) =
            Nox.transfer(o.qtyRemaining, escrowShares[msg.sender], o.qtyRemaining);

        o.qtyRemaining = newRemaining;
        escrowShares[msg.sender] = newMakerShares;

        Nox.allowThis(newRemaining);
        Nox.allowThis(newMakerShares);
        Nox.addViewer(newMakerShares, msg.sender);
    }

    /// Clears PendingResolution once the maker has confirmed off-chain that
    /// the async result materialised. Kept manual: the contract cannot read
    /// the outcome, so it cannot decide this for itself.
    function reopen(uint256 id) external {
        Order storage o = orders[id];
        require(msg.sender == o.maker, "not maker");
        require(o.state == OrderState.PendingResolution, "not pending");
        o.state = OrderState.Open;
    }
}
