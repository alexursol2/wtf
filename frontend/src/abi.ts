/**
 * Hand-written minimal ABIs. Only what the UI calls — keeping these small makes
 * it obvious which surface the frontend actually depends on.
 *
 * Note the encrypted parameter types: `externalEuint256` and `euint256` are both
 * user-defined value types over bytes32, so they appear as bytes32 in the ABI.
 */

export const VENUE_ABI = [
  // escrow
  "function depositCash(bytes32 encAmount, bytes proof) external",
  "function depositShares(bytes32 encAmount, bytes proof) external",
  "function escrowCash(address) view returns (bytes32)",
  "function escrowShares(address) view returns (bytes32)",

  // withdrawal — the counterpart to deposit, added in the two-sided venue
  "function withdrawCash(bytes32 encAmount, bytes proof) external",
  "function withdrawShares(bytes32 encAmount, bytes proof) external",

  // maker — both sides of the book rest here
  "function postAsk(uint8 instrument, bytes32 encQty, bytes32 encPrice, bytes qtyProof, bytes priceProof, uint64 expiry) external returns (uint256)",
  "function postBid(uint8 instrument, bytes32 encQty, bytes32 encPrice, bytes qtyProof, bytes priceProof, uint64 expiry) external returns (uint256)",
  "function cancel(uint256 id) external",
  "function reopen(uint256 id) external",

  // taker — fill lifts an ask, hit sells into a bid
  "function fill(uint256 id, bytes32 encBid, bytes32 encQty, bytes bidProof, bytes qtyProof, uint8 declaredBucket) external",
  "function hit(uint256 id, bytes32 encAsk, bytes32 encQty, bytes askProof, bytes qtyProof, uint8 declaredBucket) external",

  // disclosure
  "function reportTrade(uint256 fillId) external",
  "function publishVolume(uint256 fillId) external",

  // enumeration — counts, not logs. Hosted RPCs cap eth_getLogs at a narrow
  // block range (10 blocks on Alchemy's free tier), so scanning from block 0
  // is not an option, and the Nox subgraph indexes handles rather than these
  // events.
  "function ordersCount() view returns (uint256)",
  "function fillsCount() view returns (uint256)",

  // state
  // `side` and `instrument` are PLAINTEXT: which security is quoted, and which
  // way, is not the secret — the size and the price are. That is what makes
  // separate books possible at all, since an encrypted tag could never be
  // compared.
  "function orders(uint256) view returns (address maker, uint8 side, uint8 instrument, bytes32 qtyRemaining, bytes32 cashRemaining, bytes32 price, uint64 expiry, uint8 state)",
  "function fills(uint256) view returns (address maker, address taker, uint8 instrument, bytes32 qty, bytes32 price, uint8 bucket, uint64 volumeDeferredUntil, bool reported, bool volumePublished)",
  "function PRICE_SCALE() view returns (uint256)",
  "function LIS_DEFERRAL() view returns (uint64)",
  "function auditor() view returns (address)",
  "function identityRegistry() view returns (address)",

  // Circuit breakers. Added to the contract after the live Sepolia deployment
  // was verified, so the frontend probes `paused()` and degrades when the call
  // reverts rather than assuming the venue has them.
  "function paused() view returns (bool)",
  "function fillFrozen(uint256) view returns (bool)",
  "function setPaused(bool value) external",
  "function setFillFrozen(uint256 fillId, bool value) external",

  // events — used to enumerate, since arrays have no length getter here
  "event OrderPosted(uint256 indexed id, address indexed maker, uint64 expiry)",
  "event FillRecorded(uint256 indexed fillId, uint256 indexed orderId, address indexed taker, uint8 bucket)",
  "event TradeReported(uint256 indexed fillId)",
  "event VolumePublished(uint256 indexed fillId)",
] as const;

/** Only the disclosure-state reads. The UI must never claim a value it cannot verify. */
export const NOX_ABI = [
  "function isPubliclyDecryptable(bytes32 handle) view returns (bool)",
  "function isViewer(bytes32 handle, address viewer) view returns (bool)",
  "function isAllowed(bytes32 handle, address account) view returns (bool)",
] as const;

/**
 * Compliance is shown BEFORE an order is attempted, not surfaced as a revert
 * afterwards, so the UI reads these directly.
 */
export const IDENTITY_REGISTRY_ABI = [
  "function isVerified(address account) view returns (bool)",
  "function investorCountry(address account) view returns (uint16)",
] as const;

export const WRAPPER_ABI = [
  "function underlying() view returns (address)",
  "function countryGateActive() view returns (bool)",
  "function allowedCountry(uint16) view returns (bool)",
  "function grantRegisterAccess(address holder, address viewer) external",
  "function wrap(uint256 amount) external",
  "function requestUnwrap(uint256 amount) external returns (uint256)",
  "function claimUnwrap(uint256 requestId, bytes okProof) external",
  "function confidentialTransfer(address to, bytes32 encAmount, bytes proof) external",
  "function balanceHandle(address account) view returns (bytes32)",
] as const;

export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
] as const;
