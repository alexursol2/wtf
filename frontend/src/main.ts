/**
 * Deferral Venue frontend.
 *
 * Three rules drive this file.
 *
 * 1. NEVER INVENT A NUMBER. Encrypted values cannot be read on-chain, and
 *    decryption goes through the Nox gateway. Where a plaintext value is not
 *    available, the UI shows the handle and its real on-chain disclosure state
 *    rather than a placeholder. A withheld value is shown as withheld, never as
 *    zero.
 *
 * 2. ASYNC IS STRUCTURAL, NOT COSMETIC. Nox is TEE-async: a transaction commits,
 *    then a Runner decrypts inside Intel TDX, computes, re-encrypts and stores.
 *    A confirmed receipt does NOT mean a value exists yet, so every write runs
 *    through one lifecycle (see ui.ts) that distinguishes "mined" from
 *    "resolved".
 *
 * 3. TELL PEOPLE BEFORE, NOT AFTER. Compliance state is shown before an order is
 *    attempted; a failure is explained with the specific reason rather than a
 *    red line.
 */
import {
  BrowserProvider,
  Contract,
  JsonRpcSigner,
  JsonRpcProvider,
  Wallet,
  ZeroHash,
  parseUnits,
  formatUnits,
} from "ethers";
import {
  createEthersHandleClient,
  NotYetComputedHandleError,
  UnknownHandleError,
  type HandleClient,
} from "@iexec-nox/handle";
import { VENUE_ABI, NOX_ABI, WRAPPER_ABI, ERC20_ABI, IDENTITY_REGISTRY_ABI } from "./abi.js";
import { CONFIG, NOX_COMPUTE, CHAIN_NAMES, ORDER_STATE_LABEL, OrderState, Bucket } from "./config.js";
import { INSTRUMENTS, countryName, pairLabel, type Instrument } from "./reference.js";
import { initTooltips } from "./tooltip.js";
import {
  asyncAction,
  copyable,
  escapeHtml,
  flashReveal,
  setLock,
  statusChip,
  toast,
  wireCopyButtons,
} from "./ui.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const el = (id: string) => document.getElementById(id);

const short = (h: string) => (h && h !== ZeroHash ? `${h.slice(0, 12)}…${h.slice(-8)}` : "—");
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmt = (v: bigint) => v.toLocaleString("en-US");

function mmss(total: number): string {
  const s = Math.max(0, Math.floor(total));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function banner(message: string, kind: "error" | "info" | "ok" = "info") {
  const b = $("banner");
  b.textContent = message;
  b.className = `banner ${kind}`;
}

function clearBanner() {
  $("banner").className = "banner hidden";
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

type Role = "trader" | "auditor";

const state = {
  provider: null as BrowserProvider | null,
  signer: null as JsonRpcSigner | null,
  account: "",
  chainId: 0,
  venue: null as Contract | null,
  nox: null as Contract | null,
  handleClient: null as HandleClient | null,
  handleClientFor: "",
  priceScale: 10000n,
  lisDeferral: 90n,
  auditor: "",
  registry: "",
  instrumentSymbol: "",
  role: "trader" as Role,
  compliance: {
    verified: null as boolean | null,
    country: 0,
    countryGateActive: false,
    countryAllowed: true,
  },
  /** Selected trading pair. Only the live one has a deployed token. */
  instrument: INSTRUMENTS[0] as Instrument,
  /** Decrypted escrow, kept so the allocation slider has something to size against. */
  escrow: { cash: null as bigint | null, shares: null as bigint | null },
  /** Circuit-breaker support, discovered by feature detection at boot. */
  breaker: { supported: false, paused: false, checked: false },
};

// ---------------------------------------------------------------------------
// order entry state
// ---------------------------------------------------------------------------

/**
 * The venue is ASK-ONLY, and that is a property of the contract, not a gap in
 * this screen. `postAsk` creates resting liquidity; `fill` consumes it. There is
 * no `postBid`, so:
 *
 *   SELL = post an ask   — you become the maker and the reporting entity
 *   BUY  = fill an ask   — you are the taker, hitting one resting order
 *
 * That also decides what the order types can honestly mean. A LIMIT BUY is
 * native: `Nox.ge(bid, o.price)` compares your encrypted bid against the
 * encrypted ask, and a bid that does not cross settles for zero. A MARKET BUY
 * is a bid set high enough to cross whatever the ask turns out to be — safe,
 * because the taker is debited `qty × ask ÷ SCALE`, never the bid, so bidding
 * high does not overpay. A MARKET SELL has nothing to hit: there are no resting
 * bids to lift, so it is refused rather than faked.
 */
type Side = "buy" | "sell";
type OrderType = "limit" | "market";

const entry = {
  side: "sell" as Side,
  type: "limit" as OrderType,
  gtc: false,
};

/** GTC has no "never" on-chain — expiry is a uint64 the contract compares to
 *  block.timestamp — so it is expressed as a date far past any demo horizon. */
const GTC_EXPIRY = 4_102_444_800n; // 2100-01-01Z

/** A market buy must cross an unknown, encrypted ask. uint256 headroom is
 *  enormous, but safeMul still has to not overflow downstream, so this is large
 *  enough to cross any sane quote and far below the overflow gate. */
const MARKET_BID = 10n ** 12n;

// ---------------------------------------------------------------------------
// encrypted values
// ---------------------------------------------------------------------------

function handleConfigOverride(): any {
  const o: Record<string, string> = {};
  const g = (import.meta.env as any).VITE_NOX_GATEWAY_URL;
  const s = (import.meta.env as any).VITE_NOX_SUBGRAPH_URL;
  if (g) o.gatewayUrl = g;
  if (s) o.subgraphUrl = s;
  return Object.keys(o).length ? o : undefined;
}

function readOnlyProvider(): JsonRpcProvider {
  const url =
    (import.meta.env as any).VITE_RPC_URL ??
    (CONFIG.expectedChainId === 421614
      ? "https://arbitrum-sepolia-rpc.publicnode.com"
      : "https://ethereum-sepolia-rpc.publicnode.com");
  return new JsonRpcProvider(url, CONFIG.expectedChainId);
}

/**
 * Cached AGAINST THE ACCOUNT IT BELONGS TO, never on its own.
 *
 * The page loads read-only so the tape renders without a wallet, and that path
 * builds a client bound to a throwaway wallet. Cache it unconditionally and it
 * survives the user connecting MetaMask, so encryptInput goes on minting proofs
 * owned by an address nobody controls — rejected on-chain with a bare custom
 * error during gas estimation, so the wallet never even opens. Keying on the
 * account makes that unrepresentable.
 */
async function getHandleClient(): Promise<HandleClient> {
  const wanted = state.account || "readonly";
  if (state.handleClient && state.handleClientFor === wanted) return state.handleClient;

  if (state.signer) {
    state.handleClient = await createEthersHandleClient(state.signer as any, handleConfigOverride());
  } else {
    const ephemeral = Wallet.createRandom().connect(readOnlyProvider());
    state.handleClient = await createEthersHandleClient(ephemeral as any, handleConfigOverride());
  }
  state.handleClientFor = wanted;
  return state.handleClient;
}

/**
 * True when a decrypt failure means "wait", not "denied".
 *
 * Three transient classes and only two are exported by the SDK.
 * SubgraphOutOfSyncError fires on a one-block lag and must be matched by
 * message. The gateway's 403 "not a viewer" is genuinely ambiguous — it means
 * both "no grant" and "grant not yet indexed" — so it is treated as pending;
 * the on-chain isViewer check upstream is what decides whether a grant exists.
 */
function isTransient(e: any): boolean {
  if (e instanceof NotYetComputedHandleError || e instanceof UnknownHandleError) return true;
  if (e?.constructor?.name === "SubgraphOutOfSyncError") return true;
  return /not yet computed|unknown handle|out of sync|not a viewer|access_denied/i.test(
    e?.message ?? "",
  );
}

async function encryptInput(value: bigint, app: string) {
  const client = await getHandleClient();
  const { handle, handleProof } = await client.encryptInput(value, "uint256", app as any);
  return { handle, proof: handleProof };
}

/**
 * Decrypted values, cached by handle.
 *
 * Safe to cache indefinitely, and that is a property of the protocol rather
 * than an assumption: a Nox handle is immutable. Every operation mints a NEW
 * handle — that is why the contract has to re-grant an ACL after each one — so
 * a handle's plaintext can never change underneath the cache. Only its
 * disclosure state can, and that is read separately on-chain.
 *
 * Without this the auditor's panel re-decrypted every row on every 20-second
 * poll, so each block update flashed the whole column back to "decrypting…"
 * even though nothing about those fills had changed.
 */
const decrypted = new Map<string, bigint>();

async function tryDecrypt(handle: string): Promise<bigint | null> {
  if (!handle || handle === ZeroHash) return null;
  const hit = decrypted.get(handle);
  if (hit !== undefined) return hit;
  try {
    const client = await getHandleClient();
    const { value } = await client.decrypt(handle as any);
    const v = BigInt(value as bigint);
    decrypted.set(handle, v);
    return v;
  } catch (e: any) {
    if (isTransient(e)) return null;
    throw e;
  }
}

const publicValues = new Map<string, bigint>();

async function tryPublicDecrypt(handle: string): Promise<bigint | null> {
  if (!handle || handle === ZeroHash) return null;
  const cached = publicValues.get(handle);
  if (cached !== undefined) return cached;
  try {
    const client = await getHandleClient();
    const { value } = await client.publicDecrypt(handle as any);
    const v = BigInt(value as bigint);
    publicValues.set(handle, v);
    return v;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

/**
 * The role is DECIDED BY THE CONNECTED WALLET, not chosen from a menu.
 *
 * The auditor is the one address fixed in the contract at deployment
 * (`venue.auditor()`), so "logging in as the auditor" literally means holding
 * that address's key — it cannot be spoofed and there is nothing to pick.
 * Connect that wallet and the whole interface becomes the regulator's, inverted
 * theme and all; connect anything else, or nothing, and it is the trading view.
 *
 * Trader and maker are NOT separate: the contract knows neither, any verified
 * address may post or fill, and posting is what makes you a maker. So they share
 * one workspace. The view shapes what you see; it grants nothing.
 */
function setView(role: Role) {
  state.role = role;
  document.documentElement.dataset.role = role;
  el("viewTrader")?.classList.toggle("hidden", role !== "trader");
  el("viewAuditor")?.classList.toggle("hidden", role !== "auditor");
  el("roleTag")?.classList.toggle("hidden", role !== "auditor");
  applyColumnWidths();
  void refresh();
}

/** Picks the view from the connected account. Read-only defaults to trading. */
function applyRoleForAccount() {
  const isAuditor =
    !!state.account && !!state.auditor && state.account.toLowerCase() === state.auditor.toLowerCase();
  setView(isAuditor ? "auditor" : "trader");
}

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

async function connect() {
  const eth = (window as any).ethereum;
  if (!eth) {
    banner("No injected wallet found. Install MetaMask or use a browser wallet.", "error");
    return;
  }

  state.provider = new BrowserProvider(eth);
  await state.provider.send("eth_requestAccounts", []);
  state.signer = await state.provider.getSigner();
  state.account = await state.signer.getAddress();
  state.chainId = Number((await state.provider.getNetwork()).chainId);

  // Drop anything built for a previous identity, including the read-only client.
  state.handleClient = null;
  state.handleClientFor = "";

  const noxAddress = NOX_COMPUTE[state.chainId];
  if (!noxAddress) {
    banner(
      `Chain ${state.chainId} has no NoxCompute deployment. Switch to Ethereum Sepolia — anything else reverts "Nox: Unsupported chain".`,
      "error",
    );
    return;
  }
  if (CONFIG.expectedChainId && state.chainId !== CONFIG.expectedChainId) {
    banner(
      `Connected to ${CHAIN_NAMES[state.chainId] ?? state.chainId}, but the deployment is on ${
        CHAIN_NAMES[CONFIG.expectedChainId] ?? CONFIG.expectedChainId
      }.`,
      "error",
    );
    return;
  }
  if (!CONFIG.venue) {
    banner("No venue configured — set VITE_VENUE.", "error");
    return;
  }

  state.venue = new Contract(CONFIG.venue, VENUE_ABI, state.signer);
  state.nox = new Contract(noxAddress, NOX_ABI, state.provider);

  try {
    await loadConstants();
  } catch {
    banner("Could not read the venue — is VITE_VENUE correct for this chain?", "error");
    return;
  }

  $("netLabel").textContent = `${CHAIN_NAMES[state.chainId] ?? state.chainId} · ${shortAddr(state.account)}`;
  $("netLabel").className = "pill ok";
  $("connect").classList.add("hidden");
  $("disconnect").classList.remove("hidden");

  clearBanner();
  // The connected address decides the view. If it is the regulator, the whole
  // interface becomes the auditor's; otherwise it is the trading workspace.
  applyRoleForAccount();
}

/**
 * Clears this site's session. A dapp cannot log you out of a wallet — only the
 * wallet can — so we ask for a real revoke where MetaMask supports it and
 * otherwise clear our own state. Everything account-derived goes together,
 * including the handle client: leaving it behind is exactly the bug above, in
 * reverse.
 */
async function disconnect() {
  try {
    await (window as any).ethereum?.request?.({
      method: "wallet_revokePermissions",
      params: [{ eth_accounts: {} }],
    });
  } catch {
    /* older MetaMask — clearing our own session is still correct */
  }

  state.provider = null;
  state.signer = null;
  state.account = "";
  state.chainId = 0;
  state.handleClient = null;
  state.handleClientFor = "";
  state.compliance = { verified: null, country: 0, countryGateActive: false, countryAllowed: true };

  for (const id of ["cashValue", "sharesValue", "bondBalance", "wrappedValue"]) {
    const n = el(id);
    if (n) n.textContent = "—";
  }
  for (const id of ["cashHandle", "sharesHandle", "wrappedHandle"]) {
    const n = el(id);
    if (n) n.innerHTML = "";
  }
  for (const id of ["cashLock", "sharesLock", "wrappedLock"]) setLock(el(id), false);
  for (const id of ["cashStatus", "sharesStatus", "wrappedStatus"]) {
    const n = el(id);
    if (n) {
      n.className = "status submitted";
      n.textContent = "no handle";
    }
  }

  $("connect").classList.remove("hidden");
  $("connect").textContent = "Connect wallet";
  $("disconnect").classList.add("hidden");
  $("complianceChip").className = "pill muted";
  $("complianceChip").textContent = "compliance unknown";

  toast("info", "Disconnected", "The public tape stays readable — prints do not need a wallet.");
  await connectReadOnly();
}

async function loadConstants() {
  const v = state.venue!;
  state.priceScale = await v.PRICE_SCALE();
  state.lisDeferral = await v.LIS_DEFERRAL();
  state.auditor = await v.auditor();
  try {
    state.registry = await v.identityRegistry();
  } catch {
    state.registry = "";
  }
  const ds = el("deferralSeconds");
  if (ds) ds.textContent = state.lisDeferral.toString();
}

async function connectReadOnly() {
  if (!CONFIG.venue || !CONFIG.expectedChainId) return;
  const noxAddress = NOX_COMPUTE[CONFIG.expectedChainId];
  if (!noxAddress) return;

  const provider = readOnlyProvider();
  state.venue = new Contract(CONFIG.venue, VENUE_ABI, provider);
  state.nox = new Contract(noxAddress, NOX_ABI, provider);

  try {
    await loadConstants();
  } catch {
    return;
  }

  $("netLabel").textContent = `${CHAIN_NAMES[CONFIG.expectedChainId]} · read-only`;
  $("netLabel").className = "pill";
  applyRoleForAccount(); // no account → trading view, public book and tape
}

// ---------------------------------------------------------------------------
// compliance — shown before an order is attempted
// ---------------------------------------------------------------------------

async function refreshCompliance() {
  const chip = $("complianceChip");

  if (!state.account) {
    chip.className = "pill muted";
    chip.textContent = "not connected";
    state.compliance.verified = null;
    renderComplianceNotice();
    return;
  }
  if (!state.registry) {
    chip.className = "pill muted";
    chip.textContent = "registry unknown";
    return;
  }

  try {
    const provider = state.signer ?? readOnlyProvider();
    const reg = new Contract(state.registry, IDENTITY_REGISTRY_ABI, provider as any);
    const verified: boolean = await reg.isVerified(state.account);
    let country = 0;
    try {
      country = Number(await reg.investorCountry(state.account));
    } catch {
      /* optional on some registries */
    }

    let gateActive = false;
    let allowed = true;
    if (CONFIG.sharesWrapper) {
      try {
        const w = new Contract(CONFIG.sharesWrapper, WRAPPER_ABI, provider as any);
        gateActive = await w.countryGateActive();
        allowed = gateActive ? await w.allowedCountry(country) : true;
      } catch {
        /* leave defaults */
      }
    }

    state.compliance = { verified, country, countryGateActive: gateActive, countryAllowed: allowed };

    // The badge reads in words; the raw protocol values move into the tooltip.
    // ERC-3643 stores the jurisdiction as an ISO 3166-1 NUMERIC code, so the
    // registry returns 250 — which is the authoritative value but says nothing
    // to a compliance officer reading a header. Name in the badge, code in the
    // detail.
    const name = countryName(country);
    const detail = `ISO code: ${country || "none"} · ${
      verified ? "ERC-3643 whitelisted" : "not on the ERC-3643 whitelist"
    }${gateActive ? ` · wrapper country gate ${allowed ? "permits" : "restricts"} ${name}` : ""}`;
    chip.dataset.tip = detail;

    if (!verified) {
      chip.className = "pill bad interactive";
      chip.textContent = "Not verified ⓘ";
      chip.dataset.tip = `${detail} — click for what verification requires.`;
    } else if (gateActive && !allowed) {
      chip.className = "pill warn interactive";
      chip.textContent = `Restricted (${name})`;
    } else {
      chip.className = "pill ok interactive";
      chip.textContent = `Verified (${name})`;
    }
  } catch {
    chip.className = "pill muted";
    chip.textContent = "compliance unknown";
    delete chip.dataset.tip;
  }

  renderComplianceNotice();
  renderAllocSource();
}

// ---------------------------------------------------------------------------
// KYC modal
// ---------------------------------------------------------------------------

function openKyc() {
  const c = state.compliance;
  const body = el("kycBody");
  const modal = el("kycModal");
  if (!body || !modal) return;

  const addr = state.account ? shortAddr(state.account) : "your address";

  body.innerHTML = !state.account
    ? `<p>No wallet is connected, so there is no identity to check. Connect one to see
       its status against the ERC-3643 register.</p>`
    : c.verified === false
      ? `<p><strong class="mono">${escapeHtml(addr)}</strong> has no registered identity in the
         ERC-3643 <span class="mono">IdentityRegistry</span>. Every venue call &mdash; deposit,
         post and fill alike &mdash; reverts with <span class="mono">"not verified"</span> before
         it touches a single ciphertext.</p>
         <h4>What verification means here</h4>
         <ul>
           <li>An <strong>agent</strong> of the token issuer calls
           <span class="mono">registerIdentity(address, identity, country)</span> on the registry.</li>
           <li>That binds an ONCHAINID contract to your address and records your jurisdiction as
           an ISO 3166-1 numeric code.</li>
           <li>Compliance modules then evaluate transfers against that identity &mdash; this is
           Layer 1, and this venue does not modify it.</li>
         </ul>
         <h4>Why the deployer is not verified</h4>
         <p>Deliberate: the deployer is the <em>issuer</em>, not a trader. It registers others and
         holds no position, which is also why connecting it shows this panel.</p>
         <h4>What you can still do</h4>
         <ul>
           <li>Read the public tape &mdash; prints need no wallet.</li>
           <li>Inspect the book: order ids, makers and expiries are public; only sizes and prices
           are sealed.</li>
         </ul>`
      : c.countryGateActive && !c.countryAllowed
        ? `<p>Identity is verified, but <strong>${escapeHtml(countryName(c.country))}</strong>
           (ISO ${c.country}) is restricted at the confidential wrapper.</p>
           <h4>What this blocks</h4>
           <ul>
             <li><strong>Wrapping and confidential transfers</strong> revert with
             <span class="mono">"country"</span>.</li>
             <li><strong>Venue trading is unaffected</strong> &mdash; the venue checks identity
             only, never jurisdiction.</li>
           </ul>
           <h4>Why the wrapper re-checks</h4>
           <p>Pooling: Layer 1 sees the wrapper as one holder of record and cannot tell the
           holders inside it apart. Re-enforcing the country rule at Layer 2 is the mitigation.</p>`
        : `<p><strong class="mono">${escapeHtml(addr)}</strong> is verified in the ERC-3643
           register, jurisdiction <strong>${escapeHtml(countryName(c.country))}</strong>
           (ISO ${c.country}).</p>
           <h4>What that permits</h4>
           <ul>
             <li>Deposit cash and shares into venue escrow.</li>
             <li>Post asks and fill resting orders.</li>
             <li>Wrap into the confidential layer${
               c.countryGateActive ? ", permitted for this jurisdiction" : ""
             }.</li>
           </ul>`;

  modal.classList.remove("hidden");
}

function closeKyc() {
  el("kycModal")?.classList.add("hidden");
}

/**
 * Says what is wrong, and what it stops you doing, BEFORE anything is attempted.
 * The distinction matters: identity blocks everything, whereas the country gate
 * only blocks the wrapper — the venue itself never checks country.
 */
function renderComplianceNotice() {
  const c = state.compliance;
  let html = "";

  if (state.account && c.verified === false) {
    html = `<div class="diagnosis">
      <h4>This address cannot trade</h4>
      <div>It has no registered identity in the ERC-3643 IdentityRegistry, so
      <span class="mono">isVerified</span> is false and every venue call reverts with
      <span class="mono">"not verified"</span> — deposit, post and fill alike.</div>
      <ul>
        <li>An agent must call <span class="mono">registerIdentity</span> for
        ${escapeHtml(shortAddr(state.account))}.</li>
        <li>The deployer is deliberately unregistered: it is the issuer, not a trader.</li>
      </ul>
    </div>`;
  } else if (c.verified && c.countryGateActive && !c.countryAllowed) {
    html = `<div class="diagnosis">
      <h4>Country ${c.country} is restricted at the confidential layer</h4>
      <div>You can still trade on the venue — it checks identity only. The
      <strong>wrapper</strong> re-enforces the country rule, so wrapping and confidential
      transfers revert with <span class="mono">"country"</span>.</div>
      <ul>
        <li>That check is the mitigation for pooling: Layer 1 sees one holder of record and
        cannot tell holders apart inside it.</li>
      </ul>
    </div>`;
  }

  const n = el("complianceNotice");
  if (n) n.innerHTML = html;
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

interface OrderRow {
  id: number;
  maker: string;
  qtyRemaining: string;
  price: string;
  expiry: bigint;
  stateCode: number;
  pricePublic: boolean;
}

interface FillRow {
  id: number;
  maker: string;
  taker: string;
  qty: string;
  price: string;
  bucket: number;
  deferredUntil: bigint;
  reported: boolean;
  volumePublished: boolean;
  pricePublic: boolean;
  volumePublic: boolean;
  priceValue: bigint | null;
  volumeValue: bigint | null;
}

let orders: OrderRow[] = [];
let fills: FillRow[] = [];

// ---------------------------------------------------------------------------
// view preferences (persisted)
// ---------------------------------------------------------------------------

/**
 * Prints the viewer has chosen to hide from the tape, forever. This is a purely
 * local, cosmetic filter — the fill still exists on-chain and the auditor still
 * sees it; the tape just stops showing it to this browser. Persisted so a hide
 * survives reloads.
 */
const HIDDEN_KEY = "tape:hidden";
const hiddenFills = new Set<number>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]") as number[];
    } catch {
      return [];
    }
  })(),
);
function persistHidden() {
  localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hiddenFills]));
}

/**
 * Original size of orders posted from THIS browser, so a partial fill can be
 * shown as a percentage.
 *
 * There is no way to derive this on-chain. `qtyRemaining` is a ciphertext that
 * shrinks as fills land, the original is never stored, and the fill struct does
 * not carry its order id — so remaining/original cannot be reconstructed from
 * contract state at all. What IS legitimate is remembering the number the user
 * typed when they posted: it is their own order and their own plaintext.
 *
 * Consequence, and it is deliberate: an order posted from another browser has
 * no known denominator, so it gets "size not disclosed" instead of a bar. A
 * fabricated percentage would be exactly the lie rule 1 forbids.
 */
const POSTED_KEY = "orders:posted";
const postedQty = new Map<number, bigint>(
  (() => {
    try {
      const raw = JSON.parse(localStorage.getItem(POSTED_KEY) ?? "{}") as Record<string, string>;
      return Object.entries(raw).map(([k, v]) => [Number(k), BigInt(v)] as [number, bigint]);
    } catch {
      return [];
    }
  })(),
);
function rememberPosted(id: number, qty: bigint) {
  postedQty.set(id, qty);
  localStorage.setItem(
    POSTED_KEY,
    JSON.stringify(Object.fromEntries([...postedQty].map(([k, v]) => [k, v.toString()]))),
  );
}

/** Order-book view controls (task: sort/filter the book). */
let bookFilter: "all" | "mine" | "others" = "all";
let bookOrder: "new" | "old" = "new";

/** The book collapses behind a button; once the user toggles it, we stop
 *  overriding their choice on connect/disconnect. */
let bookOpen = true;
let bookUserToggled = false;

function setBookOpen(open: boolean) {
  bookOpen = open;
  el("bookPanel")?.classList.toggle("hidden", !open);
  el("bookSort")?.classList.toggle("hidden", !open);
  const btn = el("bookToggle");
  if (btn) btn.setAttribute("aria-expanded", String(open));
}

/** Logged-in users lead with "My orders"; the public read-only view leads with
 *  the book. Respected only until the user opens/closes it themselves. */
function applyBookDefault() {
  if (bookUserToggled) return;
  setBookOpen(!state.account);
}

/**
 * Counts come from the contract, not from logs. Hosted RPCs cap eth_getLogs at a
 * narrow range (10 blocks on Alchemy's free tier), and the Nox subgraph indexes
 * handles rather than this contract's events.
 */
async function count(which: "orders" | "fills"): Promise<number> {
  if (!state.venue) return 0;
  try {
    return Number(
      which === "orders" ? await state.venue.ordersCount() : await state.venue.fillsCount(),
    );
  } catch {
    return 0;
  }
}

/** Reads the bond symbol once, so the ticker can colour by instrument. */
async function ensureInstrumentSymbol() {
  if (state.instrumentSymbol || !CONFIG.sharesWrapper) return;
  try {
    const provider = state.signer ?? readOnlyProvider();
    const wrapper = new Contract(CONFIG.sharesWrapper, WRAPPER_ABI, provider as any);
    const bond = new Contract(await wrapper.underlying(), ERC20_ABI, provider as any);
    state.instrumentSymbol = await bond.symbol();
  } catch {
    state.instrumentSymbol = "";
  }
}

async function isPublic(handle: string): Promise<boolean> {
  if (!state.nox || !handle || handle === ZeroHash) return false;
  try {
    return await state.nox.isPubliclyDecryptable(handle);
  } catch {
    return false;
  }
}

/**
 * Non-reentrant. Several triggers fire refresh — boot, the role switch, the
 * account/chain listeners, the 20s poll, and the countdown reaching zero — and
 * they used to overlap. Each run issues dozens of eth_calls through one ethers
 * provider; a pile of concurrent runs saturated it until requests stalled and
 * the book sat on "Loading" forever. So one runs at a time; a request that
 * arrives mid-flight sets a flag and the current run repeats once when it ends.
 */
let refreshing = false;
let refreshAgain = false;

async function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    await refreshOnce();
  } finally {
    refreshing = false;
    if (refreshAgain) {
      refreshAgain = false;
      void refresh();
    }
  }
}

async function refreshOnce() {
  if (!state.venue || !state.nox) {
    render();
    return;
  }

  const [oc, fc] = await Promise.all([count("orders"), count("fills")]);

  const nextOrders: OrderRow[] = [];
  for (let i = 0; i < oc; i++) {
    try {
      const o = await state.venue.orders(i);
      nextOrders.push({
        id: i,
        maker: o.maker,
        qtyRemaining: o.qtyRemaining,
        price: o.price,
        expiry: o.expiry,
        stateCode: Number(o.state),
        pricePublic: await isPublic(o.price),
      });
    } catch {
      /* skip */
    }
  }

  const nextFills: FillRow[] = [];
  for (let i = 0; i < fc; i++) {
    try {
      const f = await state.venue.fills(i);
      const pricePublic = await isPublic(f.price);
      const volumePublic = await isPublic(f.qty);
      nextFills.push({
        id: i,
        maker: f.maker,
        taker: f.taker,
        qty: f.qty,
        price: f.price,
        bucket: Number(f.bucket),
        deferredUntil: f.volumeDeferredUntil,
        reported: f.reported,
        volumePublished: f.volumePublished,
        pricePublic,
        volumePublic,
        // Use whatever is already cached; the actual gateway decryption happens
        // in enrich(), off the critical path.
        priceValue: pricePublic ? (publicValues.get(f.price) ?? null) : null,
        volumeValue: volumePublic ? (publicValues.get(f.qty) ?? null) : null,
      });
    } catch {
      /* skip */
    }
  }

  orders = nextOrders;
  fills = nextFills;

  // Render the structure NOW, from fast eth_calls only. Decryption goes through
  // the gateway and can be slow or stall; awaiting it here once left the book
  // stuck on "Loading" whenever the gateway was sluggish. The book and ticker
  // are ready to show "withheld"/"resolving" placeholders, so they render
  // immediately and fill in as values arrive.
  await ensureInstrumentSymbol();
  render();

  // Everything below touches the gateway — fire it without blocking the paint.
  void enrich();
}

/** Off-critical-path: decrypt what we can, then re-render. */
async function enrich() {
  await refreshCompliance();
  await refreshPosition();
  await refreshWrapper();

  let changed = false;
  for (const f of fills) {
    if (f.pricePublic && f.priceValue === null) {
      const v = await tryPublicDecrypt(f.price);
      if (v !== null) {
        f.priceValue = v;
        changed = true;
      }
    }
    if (f.volumePublic && f.volumeValue === null) {
      const v = await tryPublicDecrypt(f.qty);
      if (v !== null) {
        f.volumeValue = v;
        changed = true;
      }
    }
  }
  if (changed) render();
}

/** Your own decrypted position — plaintext, accent-framed, not market data. */
async function refreshPosition() {
  if (!state.venue || !state.nox || !state.account) return;

  for (const [leg, valueId, lockId, statusId, handleId] of [
    ["cash", "cashValue", "cashLock", "cashStatus", "cashHandle"],
    ["shares", "sharesValue", "sharesLock", "sharesStatus", "sharesHandle"],
  ] as const) {
    const valueEl = el(valueId);
    const statusEl = el(statusId);
    const handleEl = el(handleId);
    if (!valueEl || !statusEl || !handleEl) continue;

    try {
      const handle: string =
        leg === "cash"
          ? await state.venue.escrowCash(state.account)
          : await state.venue.escrowShares(state.account);

      if (!handle || handle === ZeroHash) {
        valueEl.textContent = "—";
        handleEl.innerHTML = "";
        setLock(el(lockId), false, "nothing escrowed");
        statusEl.className = "status submitted";
        statusEl.textContent = "no handle";
        continue;
      }

      handleEl.innerHTML = `${escapeHtml(short(handle))} ${copyable(handle)}`;

      const canView = await state.nox.isViewer(handle, state.account);
      if (!canView) {
        valueEl.textContent = "—";
        setLock(el(lockId), false);
        statusEl.className = "status failed";
        statusEl.textContent = "no viewer grant";
        continue;
      }

      const value = await tryDecrypt(handle);
      if (value === null) {
        valueEl.textContent = "—";
        setLock(el(lockId), false);
        statusEl.className = "status computing";
        statusEl.textContent = "resolving";
      } else {
        const changed = valueEl.textContent !== fmt(value);
        valueEl.textContent = fmt(value);
        setLock(el(lockId), true);
        statusEl.className = "status confirmed";
        statusEl.textContent = "decrypted";
        if (changed) flashReveal(valueEl);
        // The allocation slider sizes against this, so keep it in state.
        state.escrow[leg] = value;
      }
    } catch {
      statusEl.className = "status failed";
      statusEl.textContent = "read failed";
    }
  }
  renderAllocSource();
}

async function refreshWrapper() {
  if (!CONFIG.sharesWrapper || !state.account || !state.nox) return;
  const valueEl = el("wrappedValue");
  const statusEl = el("wrappedStatus");
  const handleEl = el("wrappedHandle");
  const bondEl = el("bondBalance");
  if (!valueEl || !statusEl || !handleEl || !bondEl) return;

  try {
    const provider = state.signer ?? readOnlyProvider();
    const wrapper = new Contract(CONFIG.sharesWrapper, WRAPPER_ABI, provider as any);
    const bond = new Contract(await wrapper.underlying(), ERC20_ABI, provider as any);

    const [decimals, bal] = await Promise.all([
      bond.decimals() as Promise<bigint>,
      bond.balanceOf(state.account) as Promise<bigint>,
    ]);
    bondEl.textContent = formatUnits(bal, Number(decimals));

    const handle: string = await wrapper.balanceHandle(state.account);
    if (!handle || handle === ZeroHash) {
      valueEl.textContent = "—";
      handleEl.innerHTML = "";
      setLock(el("wrappedLock"), false, "nothing wrapped");
      statusEl.className = "status submitted";
      statusEl.textContent = "no handle";
      return;
    }

    handleEl.innerHTML = `${escapeHtml(short(handle))} ${copyable(handle)}`;

    if (!(await state.nox.isViewer(handle, state.account))) {
      valueEl.textContent = "—";
      setLock(el("wrappedLock"), false);
      statusEl.className = "status failed";
      statusEl.textContent = "no viewer grant";
      return;
    }

    const v = await tryDecrypt(handle);
    if (v === null) {
      valueEl.textContent = "—";
      setLock(el("wrappedLock"), false);
      statusEl.className = "status computing";
      statusEl.textContent = "resolving";
    } else {
      const changed = valueEl.textContent !== formatUnits(v, Number(decimals));
      valueEl.textContent = formatUnits(v, Number(decimals));
      setLock(el("wrappedLock"), true);
      statusEl.className = "status confirmed";
      statusEl.textContent = "decrypted";
      if (changed) flashReveal(valueEl);
    }
  } catch {
    statusEl.className = "status failed";
    statusEl.textContent = "read failed";
  }
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

function render() {
  renderTicker();
  if (state.role === "auditor") {
    void renderAuditor();
  } else {
    applyBookDefault(); // logged-in leads with My orders; read-only with the book
    renderBook();
    renderMyOrders();
    renderTargetOptions();
  }
}

/**
 * Partial execution, drawn only when both numbers are real.
 *
 * `remaining` is decryptable when you hold the viewer grant (i.e. it is your
 * order); `original` is what this browser recorded at post time. Missing either
 * one, the row says the size was never disclosed rather than inventing a ratio.
 */
function progressMarkup(o: OrderRow): string {
  const original = postedQty.get(o.id);
  const remaining = decrypted.get(o.qtyRemaining);

  if (original === undefined || remaining === undefined || original === 0n) {
    return `<div class="progress-unknown">size sealed — no disclosed quantity to measure against</div>`;
  }

  const capped = remaining > original ? original : remaining;
  const filled = original - capped;
  const pct = Number((filled * 100n) / original);

  return `
    <div class="progress">
      <div class="progress-track"><div class="progress-bar" style="width:${pct}%"></div></div>
      <div class="progress-legend">
        <span class="filled">${pct}% filled · ${fmt(filled)}</span>
        <span>${100 - pct}% pending · ${fmt(capped)}</span>
      </div>
    </div>`;
}

function orderStatusChip(o: OrderRow, expired: boolean): string {
  if (o.stateCode === OrderState.PendingResolution) return statusChip("computing", "pending resolution");
  if (o.stateCode === OrderState.Cancelled) return statusChip("failed", "cancelled");
  if (expired) return statusChip("failed", "expired");
  return statusChip("confirmed", ORDER_STATE_LABEL[o.stateCode] ?? "open");
}

function renderBook() {
  const host = el("book");
  const live = orders.filter((o) => o.stateCode !== OrderState.Cancelled);

  // Count tag on the toggle button reflects the whole live book, not the filter.
  const countEl = el("bookCount");
  if (countEl) countEl.textContent = live.length ? `· ${live.length}` : "";

  if (!host) return;

  if (!state.venue) {
    host.innerHTML = `<p class="empty">Loading the public book…</p>`;
    return;
  }

  const acct = state.account.toLowerCase();
  const filtered = live.filter((o) => {
    if (bookFilter === "all" || !acct) return true;
    const mine = o.maker.toLowerCase() === acct;
    return bookFilter === "mine" ? mine : !mine;
  });

  if (!filtered.length) {
    const why =
      !live.length
        ? "No orders yet. The book is empty — not hidden."
        : bookFilter === "mine"
          ? "None of the open orders are yours."
          : bookFilter === "others"
            ? "Every open order is yours."
            : "No orders yet. The book is empty — not hidden.";
    host.innerHTML = `<p class="empty">${why}</p>`;
    return;
  }

  const now = BigInt(Math.floor(Date.now() / 1000));

  // Orders carry no timestamp, so "date" order is id order — ids are assigned
  // sequentially at post time, so newest id == most recent.
  const sorted = [...filtered].sort((a, b) => (bookOrder === "new" ? b.id - a.id : a.id - b.id));

  host.innerHTML = sorted
    .map((o) => {
      const mine = o.maker.toLowerCase() === state.account.toLowerCase();
      const expired = o.expiry <= now;
      const pending = o.stateCode === OrderState.PendingResolution;

      const canFill = !mine && !expired && !pending && state.compliance.verified === true;

      const gtc = o.expiry >= GTC_EXPIRY;
      return `
      <div class="row ${mine ? "mine" : ""}">
        <div class="row-main">
          <div class="row-title">
            <strong>#${o.id}</strong>
            ${orderStatusChip(o, expired)}
            ${mine ? `<span class="pill solid">yours</span>` : ""}
            ${gtc ? `<span class="pill muted">GTC</span>` : ""}
            <span class="lock"><svg><use href="#i-lock" /></svg><span>size &amp; price encrypted</span></span>
          </div>
          ${mine ? progressMarkup(o) : ""}
          <div class="row-meta">
            <span>maker ${escapeHtml(shortAddr(o.maker))}</span>
            <span class="mono">qty ${escapeHtml(short(o.qtyRemaining))}</span>
            <span class="mono">px ${escapeHtml(short(o.price))}</span>
            ${gtc ? `<span>no expiry</span>` : `<span>expires ${new Date(Number(o.expiry) * 1000).toLocaleTimeString()}</span>`}
          </div>
        </div>
        <div class="actions">
          ${
            mine
              ? ""
              : `<button class="small" data-trade="${o.id}" data-bucket="${Bucket.LargeInScale}" ${canFill ? "" : "disabled"}
                   data-tip="${
                     canFill
                       ? "Loads this order into the entry terminal, where you set bid, size and bucket before signing."
                       : expired
                         ? "This order has expired."
                         : pending
                           ? "A fill on this order is still resolving."
                           : "Your address is not verified in the ERC-3643 register."
                   }">Trade</button>`
          }
        </div>
      </div>`;
    })
    .join("");
}

function renderMyOrders() {
  const host = el("myOrders");
  if (!host) return;
  if (!state.account) {
    host.innerHTML = `<p class="empty">Connect a wallet to see your orders.</p>`;
    return;
  }
  const mine = orders.filter((o) => o.maker.toLowerCase() === state.account.toLowerCase());
  if (!mine.length) {
    host.innerHTML = `<p class="empty">You have no orders.</p>`;
    return;
  }

  const now = BigInt(Math.floor(Date.now() / 1000));

  host.innerHTML = [...mine]
    .reverse()
    .map((o) => {
      const pending = o.stateCode === OrderState.PendingResolution;
      const cancelled = o.stateCode === OrderState.Cancelled;
      const gtc = o.expiry >= GTC_EXPIRY;
      return `
      <div class="row mine">
        <div class="row-main">
          <div class="row-title">
            <strong>#${o.id}</strong>
            ${orderStatusChip(o, o.expiry <= now)}
            <span class="pill muted">sell</span>
            ${gtc ? `<span class="pill solid" data-tip="Good 'til cancelled — rests until you cancel it.">GTC</span>` : ""}
          </div>
          ${progressMarkup(o)}
          <div class="row-meta">
            <span class="mono">qty ${escapeHtml(short(o.qtyRemaining))}</span>
            <span class="mono">px ${escapeHtml(short(o.price))}</span>
            ${gtc ? "" : `<span>expires ${new Date(Number(o.expiry) * 1000).toLocaleTimeString()}</span>`}
          </div>
        </div>
        <div class="actions">
          ${
            pending
              ? `<button class="small" data-reopen="${o.id}"
                   data-tip="Settlement is async: the contract cannot read its own encrypted result, so it parks the order here until you confirm the value materialised.">Reopen order</button>`
              : ""
          }
          <button class="small" data-cancel="${o.id}" ${pending || cancelled ? "disabled" : ""}
            data-tip="${
              pending
                ? "Blocked while a fill is unresolved — cancelling now could race the settlement."
                : "Returns the unfilled remainder to your escrow. Any filled portion stands."
            }">Cancel remaining</button>
        </div>
      </div>`;
    })
    .join("");
}

/**
 * Colour for a print, derived from its parameters so the ticker is not
 * monochrome.
 *
 *  - a stable hue per INSTRUMENT (from the symbol, so several instruments would
 *    each get their own colour on a real book)
 *  - a stronger left rule and label for LIS versus standard BUCKET
 *  - the VOLUME magnitude drives how saturated the printed number is
 *
 * Right now every live fill is one instrument at one size, so the variety shows
 * as the bucket/state colours; the magnitude scale engages the moment sizes
 * differ.
 */
function hueForToken(symbol: string): number {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) % 360;
  return h;
}

function volMagnitudeClass(v: bigint): string {
  const n = Number(v);
  return n >= 2000 ? "v-hi" : n >= 500 ? "v-mid" : "v-lo";
}

let tickerSignature = "";

/** Refresh the "N hidden — show" control from the current hidden set. */
function renderUnhideControl() {
  const btn = el("tapeUnhide");
  if (!btn) return;
  const n = hiddenFills.size;
  btn.classList.toggle("hidden", n === 0);
  if (n) btn.textContent = `${n} hidden — show`;
}

/**
 * The tape as a news-style ticker.
 *
 * Two filters shape what shows: a print appears only once it has an OPEN
 * parameter (its price has printed at settlement), and only if the viewer has
 * not hidden it. So the tape is the public record — nothing dark, nothing the
 * viewer chose to drop.
 *
 * The loop is seamless by construction: the visible run is repeated until it is
 * at least as wide as the track, then that block is duplicated and translated by
 * exactly its own width (-50% of the pair), so the second copy lands where the
 * first began with no gap and no jump. Rebuilt only when the set of prints
 * actually changes — the once-a-second countdown patches text in place.
 */
function renderTicker() {
  const host = el("tape");
  if (!host) return;

  renderUnhideControl();

  // Task: the tape carries only prints with an open parameter, minus anything
  // the viewer has permanently hidden.
  const visible = fills.filter((f) => f.pricePublic && !hiddenFills.has(f.id));

  if (!visible.length) {
    const sig = `empty:${hiddenFills.size}`;
    if (tickerSignature !== sig) {
      const msg = fills.length
        ? "No open prints — sizes and prices are still dark."
        : "No prints yet — the book is empty, not hidden.";
      host.innerHTML = `<span class="ticker-empty">${msg}</span>`;
      host.style.animation = "none";
      tickerSignature = sig;
    }
    return;
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  const token = state.instrumentSymbol || "ACME30";
  const hue = hueForToken(token);

  const items = [...visible].reverse().map((f) => {
    const lis = f.bucket === Bucket.LargeInScale;
    const passed = f.reported && now >= f.deferredUntil;

    const priceCell =
      f.priceValue !== null
        ? `<span class="tick-price">${fmt(f.priceValue)}</span>`
        : `<span class="tick-held">resolving…</span>`;

    let volCell: string;
    if (f.volumePublic) {
      volCell =
        f.volumeValue !== null
          ? `<span class="tick-vol ${volMagnitudeClass(f.volumeValue)}">${fmt(f.volumeValue)}</span>`
          : `<span class="tick-held">resolving…</span>`;
    } else if (!f.reported) {
      volCell = `<span class="tick-held">unreported</span>`;
    } else if (passed) {
      volCell = `<span class="tick-ready">ready</span>`;
    } else {
      volCell = `<span class="tick-count" data-countdown="${f.deferredUntil}">${mmss(
        Number(f.deferredUntil - now),
      )}</span>`;
    }

    // Hue via inline custom property; the class only picks bucket saturation.
    const sat = lis ? 62 : 30;
    const light = 42;
    const style = `--tick-hue: hsl(${hue} ${sat}% ${light}%)`;

    return `
    <span class="tick" style="${style}">
      <span class="tick-id">#${f.id}</span>
      <span class="tick-token">${escapeHtml(token)}</span>
      <span class="pill ${lis ? "warn" : "muted"}">${lis ? "LIS" : "std"}</span>
      <span class="tick-leg"><span class="k">px</span>${priceCell}</span>
      <span class="tick-leg"><span class="k">vol</span>${volCell}</span>
      <button class="tick-hide" data-hide="${f.id}" title="Hide this print" aria-label="Hide print #${f.id}">×</button>
    </span>`;
  });

  // Rebuild only when the structure changes (visible ids, public flags, values,
  // hidden set). The countdown text is patched in place by the interval.
  const sig =
    `h${hiddenFills.size}|` +
    visible
      .map((f) => `${f.id}:${f.priceValue}:${f.volumePublic ? f.volumeValue : f.reported ? "r" : "u"}`)
      .join("|");
  if (sig === tickerSignature) return;
  tickerSignature = sig;

  paintMarquee(host, items.join(""));
}

/**
 * Lay the run out once, measure it, repeat it until one block spans the track,
 * then duplicate that block. Translating the pair by -50% shifts by exactly one
 * block width, so the loop has no seam regardless of how few prints there are.
 */
function paintMarquee(host: HTMLElement, run: string) {
  const track = host.parentElement;
  const trackWidth = track?.clientWidth ?? 0;

  host.style.animation = "none";
  host.innerHTML = run; // one copy, to measure
  const oneWidth = host.scrollWidth;

  const repeats = oneWidth > 0 && trackWidth > 0 ? Math.max(1, Math.ceil(trackWidth / oneWidth)) : 1;
  const block = run.repeat(repeats);
  host.innerHTML = block + block; // pair; -50% == exactly one block

  const blockWidth = oneWidth * repeats;
  const duration = Math.max(18, Math.round(blockWidth / 55)); // ~constant px/s
  host.style.setProperty("--marquee-duration", `${duration}s`);
  // Force a reflow so removing the inline "none" restarts cleanly from 0.
  void host.offsetWidth;
  host.style.animation = "";
}

// ---------------------------------------------------------------------------
// auditor
// ---------------------------------------------------------------------------

async function renderAuditor() {
  const isAuditor =
    state.account !== "" && state.account.toLowerCase() === state.auditor.toLowerCase();

  const idEl = el("auditorIdentity");
  if (idEl) {
    idEl.innerHTML = !state.account
      ? `Read-only. Connect the auditor wallet (<span class="mono">${escapeHtml(
          state.auditor ? shortAddr(state.auditor) : "?",
        )}</span>) to decrypt volumes.`
      : isAuditor
        ? `Connected as the auditor. The left column is decrypted with grants this address holds.`
        : `Connected as <span class="mono">${escapeHtml(shortAddr(state.account))}</span>, which is
           <strong>not</strong> the auditor. The left column stays sealed — that is the protocol,
           not this page.`;
  }

  renderAuditorFills(isAuditor);
  renderUnreported();
  void refreshBreaker();
  await renderRegister();
}

function renderAuditorFills(isAuditor: boolean) {
  const host = el("auditorFills");
  if (!host) return;
  if (!fills.length) {
    host.innerHTML = `<p class="empty">No fills yet.</p>`;
    return;
  }

  host.innerHTML = [...fills]
    .reverse()
    .map((f) => {
      const publicSees = f.volumePublic
        ? f.volumeValue !== null
          ? fmt(f.volumeValue)
          : "resolving…"
        : f.reported
          ? "withheld — deferred"
          : "nothing — unreported";

      const gapOpen = !f.volumePublic;

      return `
      <div class="row">
        <div class="row-main">
          <div class="row-title">
            <strong>fill #${f.id}</strong>
            <span class="pill ${f.bucket === Bucket.LargeInScale ? "warn" : "muted"}">${
              f.bucket === Bucket.LargeInScale ? "LIS" : "standard"
            }</span>
            ${gapOpen ? statusChip("computing", "gap open") : statusChip("confirmed", "public caught up")}
          </div>
          <div class="gap-grid">
            <div class="gap-cell regulator">
              <label>regulator sees</label>
              ${
                isAuditor
                  ? // Cached first: a value already decrypted stays on screen
                    // across polls instead of flashing back to "decrypting…".
                    // Undecrypted rows get an explicit button rather than an
                    // automatic gateway round-trip — revealing is an act.
                    decrypted.has(f.qty)
                    ? `<div class="plain" id="audvol-${f.id}">${fmt(decrypted.get(f.qty)!)}</div>`
                    : `<div id="audvol-${f.id}" class="cipher">sealed</div>
                       <button class="small" data-reveal="${f.id}"
                         data-tip="Decrypts this volume through the Nox gateway using the grant the contract gave the auditor at the moment of the fill.">Reveal encrypted volume</button>`
                  : `<div class="cipher">requires the auditor's grant</div>`
              }
            </div>
            <div class="gap-cell">
              <label>public sees</label>
              <div class="${f.volumePublic ? "plain" : "cipher"}">${escapeHtml(publicSees)}</div>
            </div>
          </div>
          <div class="row-meta">
            <span>maker ${escapeHtml(shortAddr(f.maker))}</span>
            <span>taker ${escapeHtml(shortAddr(f.taker))}</span>
          </div>
        </div>
      </div>`;
    })
    .join("");
}

/** Reveals one volume on demand. Cached, so it never re-flickers afterwards. */
async function revealAuditorValue(fillId: number, button: HTMLButtonElement) {
  const f = fills.find((x) => x.id === fillId);
  if (!f) return;

  const node = document.getElementById(`audvol-${fillId}`);
  if (node) {
    node.textContent = "decrypting…";
    node.className = "cipher";
  }
  button.disabled = true;

  try {
    const v = await tryDecrypt(f.qty);
    const cur = document.getElementById(`audvol-${fillId}`);
    if (!cur) return;
    if (v === null) {
      cur.textContent = "not yet resolved";
      cur.className = "cipher";
      button.disabled = false;
    } else {
      cur.textContent = fmt(v);
      cur.className = "plain";
      flashReveal(cur);
      button.remove();
    }
  } catch {
    const cur = document.getElementById(`audvol-${fillId}`);
    if (cur) {
      cur.textContent = "decrypt failed";
      cur.className = "cipher";
    }
    button.disabled = false;
  }
}

function renderUnreported() {
  const host = el("auditorUnreported");
  if (!host) return;
  const unreported = fills.filter((f) => !f.reported);
  if (!unreported.length) {
    host.innerHTML = `<p class="empty">Every settled fill has been reported.</p>`;
    return;
  }
  host.innerHTML = [...unreported]
    .reverse()
    .map(
      (f) => `
      <div class="row">
        <div class="row-main">
          <div class="row-title">
            <strong>fill #${f.id}</strong>
            ${statusChip("failed", "no print submitted")}
            <span class="pill warn" data-tip="reportTrade() is an obligation on the maker as the reporting entity. Settlement already moved encrypted balances, so the trade is done — only its publication is outstanding. The contract cannot compel the print, which is why the auditor holds the volume handle from the moment of the fill.">Trade settled on-chain; awaiting maker tape print submission ⓘ</span>
          </div>
          <div class="row-meta">
            <span>reporting entity ${escapeHtml(shortAddr(f.maker))}</span>
            <span>visible to the regulator, not preventable by the contract</span>
          </div>
        </div>
      </div>`,
    )
    .join("");
}

// ---------------------------------------------------------------------------
// circuit breakers
// ---------------------------------------------------------------------------

/**
 * Emergency compliance controls, feature-detected.
 *
 * `paused()` was added to DeferralVenue after the Sepolia deployment was made
 * and verified, so the live instance does not have it. Calling a function that
 * is not there returns empty data and ethers throws a decode error — which is a
 * perfectly good capability probe. The panel then says the deployment predates
 * the feature instead of offering a button that cannot work.
 */
async function refreshBreaker() {
  const stateEl = el("adminState");
  const noteEl = el("adminNote");
  const pauseBtn = el("btnPause") as HTMLButtonElement | null;
  const freezeBtn = el("btnFreeze") as HTMLButtonElement | null;
  if (!stateEl || !pauseBtn || !freezeBtn) return;

  const isAuditor =
    !!state.account && state.account.toLowerCase() === state.auditor.toLowerCase();

  if (!state.venue) {
    stateEl.textContent = "No venue configured.";
    return;
  }

  if (!state.breaker.checked) {
    try {
      state.breaker.paused = await state.venue.paused();
      state.breaker.supported = true;
    } catch {
      state.breaker.supported = false;
    }
    state.breaker.checked = true;
  }

  if (!state.breaker.supported) {
    stateEl.innerHTML = `<strong>Not available on this deployment.</strong> The live Sepolia venue
      was deployed and Etherscan-verified before circuit breakers were added, so it has no
      <span class="mono">paused()</span>. The controls exist in
      <span class="mono">DeferralVenue.sol</span> and are covered by tests; a redeploy enables them.`;
    pauseBtn.disabled = true;
    freezeBtn.disabled = true;
    if (noteEl) noteEl.textContent = "";
    return;
  }

  try {
    state.breaker.paused = await state.venue.paused();
  } catch {
    /* keep the last known value */
  }

  stateEl.innerHTML = state.breaker.paused
    ? `<strong>Order book paused.</strong> New asks and fills revert. Settled trades are untouched.`
    : `<strong>Order book live.</strong> Orders and fills are accepted normally.`;

  pauseBtn.textContent = state.breaker.paused ? "Resume order book" : "Pause order book";
  pauseBtn.disabled = !isAuditor;
  freezeBtn.disabled = !isAuditor || !fills.length;

  if (noteEl)
    noteEl.textContent = isAuditor
      ? "Pausing halts new orders and fills. It cannot reverse a settled trade — settlement has already moved encrypted balances, and there is no un-transfer."
      : "Connect the regulator wallet to arm these controls.";
}

async function onPause() {
  if (!state.venue || !state.signer) return;
  const next = !state.breaker.paused;
  await asyncAction(
    {
      button: el("btnPause") as HTMLButtonElement,
      label: next ? "Pause order book" : "Resume order book",
      onSettled: async () => {
        state.breaker.checked = false;
        await refreshBreaker();
      },
    },
    async () => (await state.venue!.setPaused(next)).wait(),
  );
}

async function onFreeze() {
  if (!state.venue || !state.signer) return;
  const raw = window.prompt(
    "Freeze which fill id? Freezing blocks its tape print until the regulator clears it.",
  );
  if (!raw) return;
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 0 || id >= fills.length) {
    toast("error", "No such fill", `Fill ids run 0–${Math.max(0, fills.length - 1)}.`);
    return;
  }
  await asyncAction(
    {
      button: el("btnFreeze") as HTMLButtonElement,
      label: `Freeze fill #${id}`,
      onSettled: refresh,
    },
    async () => (await state.venue!.setFillFrozen(BigInt(id), true)).wait(),
  );
}

async function renderRegister() {
  const host = el("auditorRegister");
  if (!host) return;
  if (!CONFIG.sharesWrapper || !state.auditor || !state.nox) {
    host.innerHTML = `<p class="empty">Set VITE_SHARES_WRAPPER to inspect the register.</p>`;
    return;
  }

  const holders = [
    ...new Set([...orders.map((o) => o.maker), ...fills.flatMap((f) => [f.maker, f.taker])]),
  ];
  if (!holders.length) {
    host.innerHTML = `<p class="empty">No holders on record yet.</p>`;
    return;
  }

  const provider = state.signer ?? readOnlyProvider();
  const wrapper = new Contract(CONFIG.sharesWrapper, WRAPPER_ABI, provider as any);

  const rows: string[] = [];
  for (const holder of holders) {
    let handle = ZeroHash;
    try {
      handle = await wrapper.balanceHandle(holder);
    } catch {
      continue;
    }
    if (handle === ZeroHash) continue;

    let granted = false;
    try {
      granted = await state.nox.isViewer(handle, state.auditor);
    } catch {
      /* leave false */
    }

    rows.push(`
      <div class="row">
        <div class="row-main">
          <div class="row-title">
            <strong class="mono">${escapeHtml(shortAddr(holder))}</strong>
            ${granted ? statusChip("confirmed", "disclosed") : statusChip("submitted", "sealed")}
            <span class="lock ${granted ? "open" : ""}"><svg><use href="#i-lock" /></svg><span>${
              granted ? "readable by the auditor" : "issuer has not disclosed"
            }</span></span>
          </div>
          <div class="row-meta">
            <span class="mono">${escapeHtml(short(handle))}</span> ${copyable(handle)}
          </div>
        </div>
      </div>`);
  }

  host.innerHTML = rows.length
    ? rows.join("")
    : `<p class="empty">No wrapped balances yet — nothing to disclose.</p>`;
}

// ---------------------------------------------------------------------------
// order entry terminal
// ---------------------------------------------------------------------------

/** Which escrow leg funds the current side: buys spend cash, sells post shares. */
const fundingLeg = (): "cash" | "shares" => (entry.side === "buy" ? "cash" : "shares");

function renderAllocSource() {
  const srcEl = el("allocSource");
  const noteEl = el("allocNote");
  if (!srcEl) return;

  const leg = fundingLeg();
  const bal = state.escrow[leg];

  if (!state.account) {
    srcEl.textContent = "connect a wallet";
    if (noteEl) noteEl.textContent = "";
    return;
  }
  if (bal === null) {
    srcEl.textContent = `${leg} — encrypted`;
    if (noteEl)
      noteEl.textContent =
        "Your escrow has not resolved yet, so the slider has nothing to size against. Enter a quantity directly.";
    return;
  }

  srcEl.textContent = `${fmt(bal)} ${leg}`;
  if (noteEl)
    noteEl.textContent =
      entry.side === "buy"
        ? "Percentage of escrowed cash, converted at your limit price."
        : "Percentage of escrowed shares.";
}

/** Slider/preset → quantity. Buying converts cash to a share count at the limit. */
function applyAllocation(pct: number) {
  const qtyEl = el("entryQty") as HTMLInputElement | null;
  const bal = state.escrow[fundingLeg()];
  if (!qtyEl || bal === null) {
    toast("info", "Escrow not resolved", "The percentage needs a decrypted balance to size against.");
    return;
  }

  if (entry.side === "sell") {
    qtyEl.value = ((bal * BigInt(pct)) / 100n).toString();
    return;
  }

  // Buying: cash buys qty = cash × SCALE ÷ price. At market the ask is unknown
  // — it is a ciphertext — so there is no honest conversion to make.
  const price = BigInt((el("entryPrice") as HTMLInputElement)?.value || "0");
  if (entry.type === "market" || price <= 0n) {
    toast(
      "info",
      "Set a limit price first",
      "Converting cash into a share count needs a price. At market the ask is a ciphertext, so the venue cannot size it for you.",
    );
    return;
  }
  qtyEl.value = (((bal * BigInt(pct)) / 100n) * state.priceScale / price).toString();
}

/** Repaint the terminal for the current side and order type. */
function renderEntry() {
  const buy = entry.side === "buy";
  const market = entry.type === "market";

  el("sideBuy")?.classList.toggle("on", buy);
  el("sideSell")?.classList.toggle("on", !buy);
  el("sideBuy")?.setAttribute("aria-pressed", String(buy));
  el("sideSell")?.setAttribute("aria-pressed", String(!buy));

  document
    .querySelectorAll<HTMLElement>("[data-ordertype]")
    .forEach((n) => n.classList.toggle("on", n.dataset.ordertype === entry.type));

  // Buy hits one resting order; sell creates one, so the target picker and the
  // expiry/bucket controls swap over.
  el("targetField")?.classList.toggle("hidden", !buy);
  el("expiryField")?.classList.toggle("hidden", buy);

  const priceEl = el("entryPrice") as HTMLInputElement | null;
  const priceLabel = el("priceLabel");
  const priceNote = el("priceNote");
  const marketPrice = market;

  if (priceEl) {
    priceEl.disabled = marketPrice;
    priceEl.required = !marketPrice;
    if (marketPrice) priceEl.value = "";
  }
  if (priceLabel) priceLabel.textContent = buy ? "Limit bid" : "Limit price";
  priceNote?.classList.toggle("hidden", !marketPrice);

  const submit = el("entrySubmit") as HTMLButtonElement | null;
  if (submit) {
    submit.textContent = buy
      ? market
        ? "Buy at market"
        : "Buy — limit"
      : market
        ? "Market sell unavailable"
        : "Post sell offer";
    submit.classList.toggle("submit-buy", buy);
    submit.classList.toggle("submit-sell", !buy);
    // A market sell has no resting bids to lift. Refuse it in the UI rather
    // than submit something that cannot mean anything on-chain.
    submit.disabled = !buy && market;
  }

  const explain = el("entryExplain");
  if (explain) {
    explain.innerHTML = buy
      ? market
        ? `<strong>Market buy.</strong> Executes against best available dark liquidity: your bid is
           set high enough to cross whatever the ask turns out to be. You are still debited
           <span class="mono">qty × ask ÷ 1e4</span>, never your bid, so bidding high does not
           overpay.`
        : `<strong>Limit buy.</strong> Your bid is encrypted and compared to the encrypted ask
           inside the TEE. If it does not cross, the fill settles for <strong>zero</strong> — no
           revert, because reverting would tell you where the ask sits.`
      : market
        ? `<strong>Market sell is unavailable on this venue.</strong> The book is ask-only (RFQ):
           there are no resting bids to lift. Post a limit offer and wait to be hit.`
        : `<strong>Limit sell.</strong> Posts resting liquidity at your price. Size and price are
           encrypted before they leave this browser; you become the maker and the
           <em>reporting entity</em> for any fill.`;
  }

  const unit = el("qtyUnit");
  if (unit) unit.textContent = state.instrument.symbol;

  renderTargetOptions();
  renderAllocSource();
}

/** Open orders the connected account may hit — never its own (self-fill reverts). */
function renderTargetOptions() {
  const sel = el("targetOrder") as HTMLSelectElement | null;
  if (!sel) return;

  const now = BigInt(Math.floor(Date.now() / 1000));
  const acct = state.account.toLowerCase();
  const hittable = orders.filter(
    (o) =>
      o.stateCode === OrderState.Open &&
      o.expiry > now &&
      (!acct || o.maker.toLowerCase() !== acct),
  );

  const keep = sel.value;
  sel.innerHTML = hittable.length
    ? hittable
        .reverse()
        .map(
          (o) =>
            `<option value="${o.id}">#${o.id} · maker ${escapeHtml(shortAddr(o.maker))} · size sealed</option>`,
        )
        .join("")
    : `<option value="">No resting orders you can hit</option>`;
  if (keep && hittable.some((o) => String(o.id) === keep)) sel.value = keep;
}

async function onEntrySubmit(e: Event) {
  e.preventDefault();
  if (!requireReady()) return;

  const qty = BigInt((el("entryQty") as HTMLInputElement)?.value || "0");
  if (qty <= 0n) {
    toast("error", "Quantity must be positive");
    return;
  }

  if (entry.side === "buy") {
    const target = (el("targetOrder") as HTMLSelectElement)?.value;
    if (!target) {
      toast("error", "No order selected", "A buy takes liquidity, so it needs a resting order to hit.");
      return;
    }
    const bucket = Number((el("entryBucket") as HTMLSelectElement)?.value ?? Bucket.LargeInScale);

    let bid: bigint;
    if (entry.type === "market") {
      bid = MARKET_BID;
    } else {
      bid = BigInt((el("entryPrice") as HTMLInputElement)?.value || "0");
      if (bid <= 0n) {
        toast("error", "Limit bid must be positive");
        return;
      }
    }

    await asyncAction(
      {
        button: el("entrySubmit") as HTMLButtonElement,
        label: `${entry.type === "market" ? "Market" : "Limit"} buy #${target}`,
        async: true,
        onSettled: refresh,
      },
      async () => {
        const b = await encryptInput(bid, CONFIG.venue);
        const q = await encryptInput(qty, CONFIG.venue);
        const tx = await state.venue!.fill(BigInt(target), b.handle, q.handle, b.proof, q.proof, bucket);
        return tx.wait();
      },
    );
    return;
  }

  // ---- sell: post an ask ----
  if (entry.type === "market") {
    toast("error", "Market sell unavailable", "This venue is ask-only — there are no resting bids to lift.");
    return;
  }

  const price = BigInt((el("entryPrice") as HTMLInputElement)?.value || "0");
  if (price <= 0n) {
    toast("error", "Limit price must be positive");
    return;
  }

  const expiry = entry.gtc
    ? GTC_EXPIRY
    : BigInt(Math.floor(Date.now() / 1000)) +
      BigInt((el("entryExpiry") as HTMLInputElement)?.value || "60") * 60n;

  await asyncAction(
    { button: el("entrySubmit") as HTMLButtonElement, label: "Post sell offer", async: true, onSettled: refresh },
    async () => {
      const q = await encryptInput(qty, CONFIG.venue);
      const p = await encryptInput(price, CONFIG.venue);
      const tx = await state.venue!.postAsk(q.handle, p.handle, q.proof, p.proof, expiry);
      const receipt = await tx.wait();
      // Remember the size so this order can show a real fill percentage later.
      // The id is the pre-push array length, i.e. the count before this post.
      try {
        const id = (await count("orders")) - 1;
        if (id >= 0) rememberPosted(id, qty);
      } catch {
        /* progress bar degrades to "size not disclosed" — never to a guess */
      }
      return receipt;
    },
  );
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

function requireReady(): boolean {
  if (!state.venue || !state.signer) {
    toast("error", "Connect a wallet first");
    return false;
  }
  if (state.compliance.verified === false) {
    toast(
      "error",
      "This address cannot trade",
      "No registered identity — isVerified is false, so the venue reverts before touching any ciphertext.",
    );
    return false;
  }
  return true;
}

async function onDeposit(e: Event) {
  e.preventDefault();
  if (!requireReady()) return;

  const typed = BigInt(($("depositAmount") as HTMLInputElement).value || "0");
  const leg = ($("depositLeg") as HTMLSelectElement).value as "cash" | "shares";
  if (typed <= 0n) {
    toast("error", "Amount must be positive");
    return;
  }

  const amount = withBuffer(typed);

  await asyncAction(
    {
      button: document.querySelector<HTMLButtonElement>(`[data-async="deposit"]`),
      label: `Deposit ${leg}`,
      async: true,
      onSettled: refresh,
    },
    async () => {
      const enc = await encryptInput(amount, CONFIG.venue);
      const tx =
        leg === "cash"
          ? await state.venue!.depositCash(enc.handle, enc.proof)
          : await state.venue!.depositShares(enc.handle, enc.proof);
      return tx.wait();
    },
  );
}

/**
 * Settlement overhead buffer.
 *
 * The failure this prevents is specific and silent. `fill` computes
 * `need = qty × price ÷ PRICE_SCALE` with integer division, then gates the
 * whole trade on `Nox.transfer`'s success flag, which is just
 * `balance >= need`. Fund the exact quantity and any rounding at the price
 * scale leaves you a unit short — at which point the transfer reports false,
 * `qtyOut` is selected to zero, and the fill settles for NOTHING. There is no
 * revert and no error, because a revert would leak the shortfall. So a
 * shortfall looks exactly like a trade that simply did not happen.
 *
 * A few basis points of headroom removes that class of failure entirely, and
 * escrow is withdrawable, so the buffer is not a cost.
 */
const BUFFER_BPS = 50n; // 0.5%

function withBuffer(amount: bigint): bigint {
  const on = (el("depositBuffer") as HTMLInputElement | null)?.checked;
  return on ? amount + (amount * BUFFER_BPS) / 10_000n : amount;
}

function renderDepositPreview() {
  const out = el("depositPreview");
  if (!out) return;
  const typed = BigInt((el("depositAmount") as HTMLInputElement)?.value || "0");
  if (typed <= 0n) {
    out.textContent = "";
    return;
  }
  const total = withBuffer(typed);
  out.textContent =
    total === typed
      ? `Depositing exactly ${fmt(typed)} — no headroom for rounding at settlement.`
      : `Depositing ${fmt(total)} (${fmt(typed)} + ${fmt(total - typed)} buffer).`;
}

/**
 * Loads a book row into the entry terminal instead of filling it inline.
 *
 * The old path asked for bid and size through two `window.prompt` calls, which
 * is not how anyone trades and gave no chance to see the balance being spent.
 * A book row is now a route into the terminal, where the order type, bucket and
 * allocation are all visible before anything is signed.
 */
function loadIntoTerminal(orderId: number, bucket: number) {
  entry.side = "buy";
  entry.type = "limit";
  renderEntry();

  const sel = el("targetOrder") as HTMLSelectElement | null;
  if (sel) sel.value = String(orderId);
  const bucketSel = el("entryBucket") as HTMLSelectElement | null;
  if (bucketSel) bucketSel.value = String(bucket);

  el("colEntry")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  (el("entryQty") as HTMLInputElement | null)?.focus();
}

async function onWrap(e: Event) {
  e.preventDefault();
  if (!state.signer) {
    toast("error", "Connect a wallet first");
    return;
  }
  if (!CONFIG.sharesWrapper) {
    toast("error", "VITE_SHARES_WRAPPER is not configured");
    return;
  }
  const c = state.compliance;
  if (c.verified === false || (c.countryGateActive && !c.countryAllowed)) {
    toast(
      "error",
      "Wrapping is blocked for this address",
      c.verified === false ? "No registered identity." : `Country ${c.country} is restricted at the wrapper.`,
    );
    return;
  }

  const raw = ($("wrapAmount") as HTMLInputElement).value;
  if (!raw || Number(raw) <= 0) {
    toast("error", "Amount must be positive");
    return;
  }

  await asyncAction(
    { button: document.querySelector<HTMLButtonElement>(`[data-async="wrap"]`), label: "Wrap bonds", onSettled: refresh },
    async () => {
      const wrapper = new Contract(CONFIG.sharesWrapper, WRAPPER_ABI, state.signer!);
      const bond = new Contract(await wrapper.underlying(), ERC20_ABI, state.signer!);
      const decimals: bigint = await bond.decimals();
      const amount = parseUnits(raw, Number(decimals));

      // wrap() pulls via transferFrom, so the approval must be mined first.
      const approval = await bond.approve(CONFIG.sharesWrapper, amount);
      await approval.wait();

      const tx = await wrapper.wrap(amount);
      return tx.wait();
    },
  );
}

// ---------------------------------------------------------------------------
// delegated row actions
// ---------------------------------------------------------------------------

document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;

  const tradeBtn = t.closest?.("[data-trade]") as HTMLButtonElement | null;
  if (tradeBtn) {
    loadIntoTerminal(Number(tradeBtn.dataset.trade), Number(tradeBtn.dataset.bucket));
    return;
  }

  const revealBtn = t.closest?.("[data-reveal]") as HTMLButtonElement | null;
  if (revealBtn) {
    void revealAuditorValue(Number(revealBtn.dataset.reveal), revealBtn);
    return;
  }

  const cancelBtn = t.closest?.("[data-cancel]") as HTMLButtonElement | null;
  if (cancelBtn) {
    void asyncAction(
      { button: cancelBtn, label: `Cancel #${cancelBtn.dataset.cancel}`, async: true, onSettled: refresh },
      async () => (await state.venue!.cancel(BigInt(cancelBtn.dataset.cancel!))).wait(),
    );
    return;
  }

  const reopenBtn = t.closest?.("[data-reopen]") as HTMLButtonElement | null;
  if (reopenBtn) {
    void asyncAction(
      { button: reopenBtn, label: `Reopen #${reopenBtn.dataset.reopen}`, onSettled: refresh },
      async () => (await state.venue!.reopen(BigInt(reopenBtn.dataset.reopen!))).wait(),
    );
    return;
  }

  // Permanently hide a print from this browser's tape. Local and cosmetic — the
  // fill is untouched on-chain and the auditor still sees it.
  const hideBtn = t.closest?.("[data-hide]") as HTMLButtonElement | null;
  if (hideBtn) {
    hiddenFills.add(Number(hideBtn.dataset.hide));
    persistHidden();
    renderTicker();
    return;
  }
});

// ---------------------------------------------------------------------------
// resizable columns
// ---------------------------------------------------------------------------

/**
 * The workspace columns are widened by dragging the handles between them. Widths
 * live in CSS custom properties on the root and persist across reloads, so a
 * layout someone sets up for filming stays put.
 */
const COLUMN_LIMITS: Record<string, [number, number]> = {
  w2: [260, 620], // wrapper column (trader)
  wa: [300, 720], // auditor side column
};

function applyColumnWidths() {
  for (const key of Object.keys(COLUMN_LIMITS)) {
    const saved = localStorage.getItem(`col:${key}`);
    if (saved) document.documentElement.style.setProperty(`--${key}`, `${saved}px`);
  }
}

function initResizers() {
  document.querySelectorAll<HTMLElement>(".resizer").forEach((handle) => {
    const key = handle.dataset.resize!;
    const [min, max] = COLUMN_LIMITS[key] ?? [240, 640];

    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("dragging");

      // w2 / wa are the RIGHT column, so dragging left should widen them — the
      // delta is inverted relative to the left-hand book column.
      const rightSide = key === "w2" || key === "wa";
      const startX = e.clientX;
      const startW =
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--${key}`)) ||
        (key === "wa" ? 420 : key === "w2" ? 360 : 340);

      const onMove = (ev: PointerEvent) => {
        const delta = (ev.clientX - startX) * (rightSide ? -1 : 1);
        const w = Math.min(max, Math.max(min, startW + delta));
        document.documentElement.style.setProperty(`--${key}`, `${w}px`);
      };
      const onUp = (ev: PointerEvent) => {
        handle.releasePointerCapture(ev.pointerId);
        handle.classList.remove("dragging");
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        const w = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--${key}`));
        if (w) localStorage.setItem(`col:${key}`, String(Math.round(w)));
      };

      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });
  });
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

wireCopyButtons(document);
initTooltips();

$("connect").addEventListener("click", () => connect().catch((e) => banner(e.message, "error")));
$("disconnect").addEventListener("click", () => disconnect().catch((e) => banner(e.message, "error")));
$("depositForm").addEventListener("submit", (e) => void onDeposit(e));
$("wrapForm").addEventListener("submit", (e) => void onWrap(e));
$("entryForm").addEventListener("submit", (e) => void onEntrySubmit(e));

// --- instrument selector
{
  const sel = el("pairSelect") as HTMLSelectElement | null;
  if (sel) {
    sel.innerHTML = INSTRUMENTS.map(
      (i, idx) =>
        `<option value="${idx}">${escapeHtml(pairLabel(i))}${i.live ? "" : " · no book"}</option>`,
    ).join("");
    sel.addEventListener("change", () => {
      state.instrument = INSTRUMENTS[Number(sel.value)] ?? INSTRUMENTS[0];
      if (!state.instrument.live) {
        banner(
          `${pairLabel(state.instrument)} has no deployed token on this venue — ${
            state.instrument.name
          } is listed to show the selector, not to imply a book. Only ${INSTRUMENTS[0].symbol} trades here.`,
          "info",
        );
      } else {
        clearBanner();
      }
      renderEntry();
      tickerSignature = "";
      render();
    });
  }
}

// --- order entry: side, type, allocation, GTC
el("sideBuy")?.addEventListener("click", () => {
  entry.side = "buy";
  renderEntry();
});
el("sideSell")?.addEventListener("click", () => {
  entry.side = "sell";
  renderEntry();
});

document.querySelectorAll<HTMLElement>("[data-ordertype]").forEach((b) =>
  b.addEventListener("click", () => {
    entry.type = b.dataset.ordertype as OrderType;
    renderEntry();
  }),
);

document.querySelectorAll<HTMLElement>("[data-alloc]").forEach((b) =>
  b.addEventListener("click", () => {
    const pct = Number(b.dataset.alloc);
    (el("allocRange") as HTMLInputElement).value = String(pct);
    applyAllocation(pct);
  }),
);

el("allocRange")?.addEventListener("input", (e) =>
  applyAllocation(Number((e.target as HTMLInputElement).value)),
);

el("entryGtc")?.addEventListener("change", (e) => {
  entry.gtc = (e.target as HTMLInputElement).checked;
  const exp = el("entryExpiry") as HTMLInputElement | null;
  if (exp) exp.disabled = entry.gtc;
});

// --- deposit buffer preview
el("depositAmount")?.addEventListener("input", renderDepositPreview);
el("depositBuffer")?.addEventListener("change", renderDepositPreview);

// --- compliance chip opens the KYC explainer
$("complianceChip").addEventListener("click", openKyc);
$("complianceChip").addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") {
    e.preventDefault();
    openKyc();
  }
});
el("kycClose")?.addEventListener("click", closeKyc);
el("kycModal")?.addEventListener("click", (e) => {
  if (e.target === el("kycModal")) closeKyc(); // click the backdrop, not the card
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeKyc();
});

// --- circuit breakers
el("btnPause")?.addEventListener("click", () => void onPause());
el("btnFreeze")?.addEventListener("click", () => void onFreeze());

// --- wallet popover: position + funding + instructions collapse behind the icon
{
  const btn = el("walletBtn");
  const panel = el("walletPanel");
  const setOpen = (open: boolean) => {
    panel?.classList.toggle("hidden", !open);
    btn?.setAttribute("aria-expanded", String(open));
  };
  btn?.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(panel?.classList.contains("hidden") ?? false);
  });
  // Click-away and Escape close it; clicks inside the panel do not.
  document.addEventListener("click", (e) => {
    if (!panel || panel.classList.contains("hidden")) return;
    const t = e.target as Node;
    if (!panel.contains(t) && t !== btn && !btn?.contains(t)) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setOpen(false);
  });
}

// --- order book: collapse behind the history button; sort/filter when open
el("bookToggle")?.addEventListener("click", () => {
  bookUserToggled = true;
  setBookOpen(el("bookPanel")?.classList.contains("hidden") ?? true);
});

el("bookSort")?.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest?.("[data-bookfilter],[data-bookorder]") as
    | HTMLElement
    | null;
  if (!b) return;
  if (b.dataset.bookfilter) {
    bookFilter = b.dataset.bookfilter as typeof bookFilter;
    b.parentElement
      ?.querySelectorAll("[data-bookfilter]")
      .forEach((n) => n.classList.toggle("on", n === b));
  } else if (b.dataset.bookorder) {
    bookOrder = b.dataset.bookorder as typeof bookOrder;
    b.parentElement
      ?.querySelectorAll("[data-bookorder]")
      .forEach((n) => n.classList.toggle("on", n === b));
  }
  renderBook();
});

// --- tape: restore everything the viewer has hidden
el("tapeUnhide")?.addEventListener("click", () => {
  hiddenFills.clear();
  persistHidden();
  renderTicker();
});

// The marquee width is measured, so a viewport change must rebuild it.
{
  let t: ReturnType<typeof setTimeout>;
  window.addEventListener("resize", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      tickerSignature = "";
      renderTicker();
    }, 200);
  });
}

/**
 * The wallet can change identity with no click of ours, which is the same hazard
 * as a stale cache. Rebuild on account change; reload on chain change, because a
 * provider's chain is fixed at construction.
 */
{
  const eth = (window as any).ethereum;
  eth?.on?.("accountsChanged", (accounts: string[]) => {
    if (!accounts?.length) void disconnect();
    else if (accounts[0].toLowerCase() !== state.account.toLowerCase())
      void connect().catch((e) => banner(e.message, "error"));
  });
  eth?.on?.("chainChanged", () => window.location.reload());
}

/**
 * Two clocks. The countdown ticks every second but only rewrites text — a
 * per-second chain poll would hammer the RPC for no information. Reaching zero
 * IS a state change, so that single transition triggers one real refresh.
 */
setInterval(() => {
  const nodes = document.querySelectorAll<HTMLElement>("[data-countdown]");
  if (!nodes.length) return;
  const now = Math.floor(Date.now() / 1000);
  let elapsed = false;
  nodes.forEach((n) => {
    const left = Number(n.dataset.countdown) - now;
    if (left <= 0) elapsed = true;
    else n.textContent = mmss(left);
  });
  if (elapsed && state.venue) void refresh();
}, 1000);

setInterval(() => {
  if (state.venue) void refresh();
}, 20_000);

applyColumnWidths();
initResizers();
renderEntry();
renderDepositPreview();
setView("trader");

if (!CONFIG.venue) {
  banner("No deployment configured — set VITE_VENUE and VITE_CHAIN_ID.", "info");
  render();
} else {
  render();
  void connectReadOnly().catch(() => {
    /* stays disconnected; Connect still works */
  });
}
