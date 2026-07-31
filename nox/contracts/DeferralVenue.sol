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

    /// Which way the resting order faces.
    ///
    /// An Ask escrows SHARES and waits for cash; a Bid escrows CASH and waits
    /// for shares. Both rest in the same array, so the book is genuinely
    /// two-sided rather than a queue of one-way quotes.
    enum Side {
        Ask,
        Bid
    }

    struct Order {
        address maker;
        Side side;
        /// Instrument this order is for. PLAINTEXT on purpose: which security is
        /// being quoted is not the secret — the size and the price are. Keeping
        /// it readable is what lets the venue serve separate books at all, since
        /// an encrypted tag could never be compared.
        uint8 instrument;
        /// Shares still on offer (Ask) or still sought (Bid).
        euint256 qtyRemaining;
        /// Cash still escrowed against a Bid. Unused, and zero, for an Ask.
        euint256 cashRemaining;
        euint256 price; // scaled by PRICE_SCALE
        OrderState state;
    }

    struct Fill {
        address maker; // the reporting entity
        address taker;
        uint8 instrument;
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

    /// How long a large-in-scale trade may keep its SIZE off the tape.
    ///
    /// One hour, which is the deferral this venue offers. MiFIR grants far
    /// longer windows for large-in-scale prints - end of day, and up to four
    /// weeks for some non-equity classes - but an hour is a length a demo can
    /// actually wait out while still being a real deferral rather than a
    /// blink. The price is public the moment the trade is reported either way;
    /// this timer only gates the volume.
    uint64 public constant LIS_DEFERRAL = 3600;

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

    event OrderPosted(uint256 indexed id, address indexed maker, Side side, uint8 instrument);
    event FillRecorded(uint256 indexed fillId, uint256 indexed orderId, address indexed taker, Bucket bucket);
    event TradeReported(uint256 indexed fillId);
    event VolumePublished(uint256 indexed fillId);
    event PausedSet(bool value);
    event FillFrozenSet(uint256 indexed fillId, bool value);
    /// `sharesLeg` distinguishes the two withdrawals; the AMOUNT is never
    /// emitted, since it is precisely what escrow keeps confidential.
    event Withdrawn(address indexed account, bool sharesLeg);

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

    /**
     * A resting ASK: the maker escrows shares and waits for a buyer.
     *
     * Orders rest until they are cancelled. There is no lifetime parameter,
     * and that is deliberate rather than an omission: the venue used to carry
     * a `uint64 expiry` that every caller set to a date past any horizon that
     * mattered, so it never expired anything and only ever showed up as a
     * meaningless timestamp in the book. A time-in-force worth having would
     * need someone to sweep expired orders and return their escrow, which no
     * one does here - an unfilled order is cancelled, not waited out.
     */
    function postAsk(
        uint8 instrument,
        externalEuint256 encQty,
        externalEuint256 encPrice,
        bytes calldata qtyProof,
        bytes calldata priceProof
    ) external returns (uint256 id) {
        require(!paused, "paused");
        require(identityRegistry.isVerified(msg.sender), "not verified");

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
                side: Side.Ask,
                instrument: instrument,
                qtyRemaining: escrowed,
                cashRemaining: euint256.wrap(0),
                price: price,
                state: OrderState.Open
            })
        );

        Nox.allowThis(newMakerShares);
        Nox.addViewer(newMakerShares, msg.sender);
        Nox.allowThis(escrowed);
        Nox.addViewer(escrowed, msg.sender);
        Nox.allowThis(price);
        Nox.addViewer(price, msg.sender);

        emit OrderPosted(id, msg.sender, Side.Ask, instrument);
    }

    /**
     * A resting BID: the maker escrows cash and waits for someone to sell.
     *
     * The mirror of postAsk, and the reason this venue now has a real book
     * rather than a queue of one-way quotes. The cash committed is
     * `qty * price / PRICE_SCALE`, computed on ciphertext exactly as `fill`
     * computes what a taker owes, so the two sides cannot disagree about what a
     * trade is worth.
     *
     * `noOverflow` gates the escrow rather than reverting: an overflowing or
     * underfunded bid escrows zero and can then only ever settle for zero.
     * Reverting would tell the caller something about their own encrypted
     * balance that the venue is not supposed to confirm.
     */
    function postBid(
        uint8 instrument,
        externalEuint256 encQty,
        externalEuint256 encPrice,
        bytes calldata qtyProof,
        bytes calldata priceProof
    ) external returns (uint256 id) {
        require(!paused, "paused");
        require(identityRegistry.isVerified(msg.sender), "not verified");

        euint256 qty = Nox.fromExternal(encQty, qtyProof);
        euint256 price = Nox.fromExternal(encPrice, priceProof);

        (ebool noOverflow, euint256 gross) = Nox.safeMul(qty, price);
        euint256 need = Nox.div(gross, priceScaleEnc);
        euint256 needGated = Nox.select(noOverflow, need, euint256.wrap(0));

        (, euint256 newMakerCash, euint256 escrowedCash) =
            Nox.transfer(escrowCash[msg.sender], euint256.wrap(0), needGated);

        escrowCash[msg.sender] = newMakerCash;

        id = orders.length;
        orders.push(
            Order({
                maker: msg.sender,
                side: Side.Bid,
                instrument: instrument,
                qtyRemaining: qty,
                cashRemaining: escrowedCash,
                price: price,
                state: OrderState.Open
            })
        );

        Nox.allowThis(newMakerCash);
        Nox.addViewer(newMakerCash, msg.sender);
        Nox.allowThis(escrowedCash);
        Nox.addViewer(escrowedCash, msg.sender);
        Nox.allowThis(qty);
        Nox.addViewer(qty, msg.sender);
        Nox.allowThis(price);
        Nox.addViewer(price, msg.sender);

        emit OrderPosted(id, msg.sender, Side.Bid, instrument);
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
        require(o.side == Side.Ask, "not an ask");
        require(o.state == OrderState.Open, "not fillable");
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
                instrument: o.instrument,
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

    /**
     * Sell into a resting BID - the mirror of fill(), and branchless the same way.
     *
     * Direction is what changes. In fill() the taker pays cash and the ORDER
     * releases shares; here the taker delivers shares and the ORDER releases
     * cash. The crossing test flips with it: the maker's bid must reach the
     * taker's asking price, `o.price >= askPrice`, where fill() asks the
     * opposite.
     *
     * The gating order matters and is deliberate. Shares move FIRST, and its
     * success flag - which already encodes "the taker actually held this many" -
     * gates the cash release. Paying first and checking delivery afterwards
     * would let an empty seller drain a bid's escrow, and no revert could undo
     * it, because the shortfall is a ciphertext nothing on-chain can read.
     *
     * The reporting entity stays the ORDER'S MAKER, exactly as in fill(). Who
     * quoted the price is what decides the obligation, not who happened to lift
     * it, so the disclosure duty does not move just because the trade came from
     * the other side of the book.
     */
    function hit(
        uint256 id,
        externalEuint256 encAsk,
        externalEuint256 encQty,
        bytes calldata askProof,
        bytes calldata qtyProof,
        Bucket declaredBucket
    ) external {
        require(!paused, "paused");
        Order storage o = orders[id];
        require(o.side == Side.Bid, "not a bid");
        require(o.state == OrderState.Open, "not fillable");
        require(identityRegistry.isVerified(msg.sender), "not verified");
        // Same storage-collision hazard as fill(): with msg.sender == o.maker
        // both sides of a leg resolve to one slot and the second write wins.
        require(msg.sender != o.maker, "self fill");

        euint256 askPrice = Nox.fromExternal(encAsk, askProof);
        euint256 offered = Nox.fromExternal(encQty, qtyProof);

        ebool crosses = Nox.ge(o.price, askPrice);
        ebool offersLess = Nox.lt(offered, o.qtyRemaining);
        euint256 fillQty = Nox.select(offersLess, offered, o.qtyRemaining);

        (ebool noOverflow, euint256 gross) = Nox.safeMul(fillQty, o.price);
        euint256 proceeds = Nox.div(gross, priceScaleEnc);

        euint256 qtyGated = Nox.select(crosses, Nox.select(noOverflow, fillQty, euint256.wrap(0)), euint256.wrap(0));
        euint256 proceedsGated =
            Nox.select(crosses, Nox.select(noOverflow, proceeds, euint256.wrap(0)), euint256.wrap(0));

        // Shares leg first. `delivered` IS the taker's funding check.
        (ebool delivered, euint256 newTakerShares, euint256 newMakerShares) =
            Nox.transfer(escrowShares[msg.sender], escrowShares[o.maker], qtyGated);

        // Cash leg, out of the order's own escrow, only against real delivery.
        euint256 cashOut = Nox.select(delivered, proceedsGated, euint256.wrap(0));
        (, euint256 newOrderCash, euint256 newTakerCash) =
            Nox.transfer(o.cashRemaining, escrowCash[msg.sender], cashOut);

        // Retire the filled size from what the bid still seeks.
        euint256 qtyOut = Nox.select(delivered, qtyGated, euint256.wrap(0));
        (, euint256 newRemaining,) = Nox.transfer(o.qtyRemaining, euint256.wrap(0), qtyOut);

        escrowShares[msg.sender] = newTakerShares;
        escrowShares[o.maker] = newMakerShares;
        escrowCash[msg.sender] = newTakerCash;
        o.cashRemaining = newOrderCash;
        o.qtyRemaining = newRemaining;
        o.state = OrderState.PendingResolution;

        euint256 snapPrice = Nox.add(o.price, euint256.wrap(0));

        uint256 fillId = fills.length;
        fills.push(
            Fill({
                maker: o.maker,
                taker: msg.sender,
                instrument: o.instrument,
                qty: qtyOut,
                price: snapPrice,
                bucket: declaredBucket,
                volumeDeferredUntil: 0,
                reported: false,
                volumePublished: false
            })
        );

        // ---- ACL. Every handle above is NEW. Miss one and it goes dead. ----
        Nox.allowThis(newTakerShares);
        Nox.allowThis(newMakerShares);
        Nox.allowThis(newTakerCash);
        Nox.allowThis(newOrderCash);
        Nox.allowThis(newRemaining);
        Nox.allowThis(qtyOut);
        Nox.allowThis(snapPrice);

        Nox.addViewer(newTakerShares, msg.sender);
        Nox.addViewer(newMakerShares, o.maker);
        Nox.addViewer(newTakerCash, msg.sender);
        Nox.addViewer(newOrderCash, o.maker);
        Nox.addViewer(newRemaining, o.maker);
        Nox.addViewer(qtyOut, msg.sender);
        Nox.addViewer(qtyOut, o.maker);
        Nox.addViewer(qtyOut, auditor);

        emit FillRecorded(fillId, id, msg.sender, declaredBucket);
    }

    // ------------------------------------------------------------------
    // Withdrawal
    // ------------------------------------------------------------------

    /**
     * Take free escrow back out.
     *
     * The counterpart deposit has always existed; this side did not, so value
     * could enter escrow and never leave except by being traded away. Both are
     * self-declared in the same way, which is the documented escrow gap - the
     * point here is only that the ledger is now symmetric.
     *
     * The transfer's success flag is ignored for the usual reason: asking for
     * more than you hold moves zero rather than reverting, because a revert
     * would confirm the size of a balance the venue cannot otherwise read.
     */
    function withdrawCash(externalEuint256 encAmount, bytes calldata proof) external {
        euint256 amount = Nox.fromExternal(encAmount, proof);
        (, euint256 updated,) = Nox.transfer(escrowCash[msg.sender], euint256.wrap(0), amount);
        escrowCash[msg.sender] = updated;
        Nox.allowThis(updated);
        Nox.addViewer(updated, msg.sender);
        emit Withdrawn(msg.sender, false);
    }

    function withdrawShares(externalEuint256 encAmount, bytes calldata proof) external {
        euint256 amount = Nox.fromExternal(encAmount, proof);
        (, euint256 updated,) = Nox.transfer(escrowShares[msg.sender], euint256.wrap(0), amount);
        escrowShares[msg.sender] = updated;
        Nox.allowThis(updated);
        Nox.addViewer(updated, msg.sender);
        emit Withdrawn(msg.sender, true);
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

    /**
     * Reclaim what the order still holds.
     *
     * Which leg comes back depends on the side, because that is what was
     * escrowed: an Ask locked up shares, a Bid locked up cash. Returning the
     * wrong one would credit a balance that was never posted.
     */
    function cancel(uint256 id) external {
        Order storage o = orders[id];
        require(msg.sender == o.maker, "not maker");
        require(o.state == OrderState.Open, "pending or cancelled");
        o.state = OrderState.Cancelled;

        if (o.side == Side.Ask) {
            (, euint256 newRemaining, euint256 newMakerShares) =
                Nox.transfer(o.qtyRemaining, escrowShares[msg.sender], o.qtyRemaining);

            o.qtyRemaining = newRemaining;
            escrowShares[msg.sender] = newMakerShares;

            Nox.allowThis(newRemaining);
            Nox.allowThis(newMakerShares);
            Nox.addViewer(newMakerShares, msg.sender);
        } else {
            (, euint256 newCash, euint256 newMakerCash) =
                Nox.transfer(o.cashRemaining, escrowCash[msg.sender], o.cashRemaining);

            o.cashRemaining = newCash;
            escrowCash[msg.sender] = newMakerCash;

            Nox.allowThis(newCash);
            Nox.allowThis(newMakerCash);
            Nox.addViewer(newMakerCash, msg.sender);
        }
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
