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
import { clearHandleStorage, persistentHandleStorage } from "./handleStorage.js";
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
  /** Overwritten from LIS_DEFERRAL at boot; the contract's constant is 1 hour. */
  lisDeferral: 3600n,
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
  /**
   * Plaintext wallet balances, in the venue's integer units.
   *
   * These are the real ceiling on a trade now that funding is automatic. Both
   * are public ERC-20/ERC-3643 reads — no ciphertext involved — which is
   * precisely why they can size a slider when an encrypted escrow balance
   * cannot always be resolved in time.
   */
  wallet: { cash: null as bigint | null, shares: null as bigint | null },
  /** Circuit-breaker support, discovered by feature detection at boot. */
  breaker: { supported: false, paused: false, checked: false },
};

// ---------------------------------------------------------------------------
// order entry state
// ---------------------------------------------------------------------------

/**
 * The book is two-sided, so each side of the form has both a taking and a
 * resting path, and which one runs depends on what is on the book:
 *
 *   BUY   takes a resting ask via `fill`, or rests a bid via `postBid`
 *   SELL  takes a resting bid via `hit`, or rests an ask via `postAsk`
 *
 * That is also what the order types mean here. A LIMIT order states the price
 * it will cross at: `Nox.ge(bid, o.price)` for a buy, `Nox.ge(o.price, ask)`
 * for a sell, and a price that does not cross settles for zero rather than
 * reverting. A MARKET order has no stated price, so it sends the edge of the
 * collar (see COLLAR_BPS) — high enough to cross a fair quote, low enough that
 * an absurd one cannot be lifted. Taking is always partial-capable: the
 * contract fills `min(wanted, resting)`, and `settleTaker` rests whatever did
 * not trade.
 */
type Side = "buy" | "sell";
type OrderType = "limit" | "market";

const entry = {
  side: "sell" as Side,
  type: "limit" as OrderType,
};

/**
 * How far from the reference price a MARKET order is willing to be filled.
 *
 * This is a real price collar, not a display nicety, and it closes a genuine
 * hole. A market buy has to cross a price it cannot read, so it used to send an
 * encrypted bid of 1e12 — a number that crosses ANY ask. The taker is debited
 * `qty × the ask ÷ SCALE`, never their own bid, so an absurd resting quote was
 * paid in full. A market sell had the mirror problem with an ask of 1: it
 * accepted whatever the bid happened to be.
 *
 * Sending `reference × (1 ± 2%)` instead turns the contract's own crossing test
 * into the collar — `Nox.ge(bid, o.price)` for a buy, `Nox.ge(o.price, ask)`
 * for a sell. Outside the band the trade settles for zero rather than at a bad
 * price, which is why `reportExecution` below decrypts what actually filled and
 * says so instead of letting a no-op look like a fill.
 */
const COLLAR_BPS = 200n; // 2%

const collarBuy = (reference: bigint) => reference + (reference * COLLAR_BPS) / 10_000n;
const collarSell = (reference: bigint) => reference - (reference * COLLAR_BPS) / 10_000n;

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

  // Give the client somewhere durable to keep its gateway authorization.
  //
  // The SDK already reuses one signature for a full hour, but only through its
  // `storageService` — and `createHandleClient` never passes one, so it defaults
  // to an in-memory object that dies with the page. Reaching past the factory is
  // not elegant; the alternative is rebuilding ApiService, SubgraphService and
  // the gateway attestation by hand, since the package exports only factories.
  // `readonly` here is a TypeScript annotation, not a runtime one.
  (state.handleClient as any).storageService = persistentHandleStorage;

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

/**
 * Decrypts run ONE AT A TIME, and that is about signature prompts, not races.
 *
 * The gateway authorization is minted lazily inside `decrypt()`: if no valid one
 * is stored, it generates an RSA keypair, asks the wallet to sign, and only
 * writes the result to storage AFTER the gateway answers successfully. Fire
 * three decrypts concurrently — a position has cash, shares and a wrapped
 * balance — and all three find an empty store, so all three sign. The stored
 * authorization the second and third would have reused does not exist yet when
 * they look.
 *
 * Serialising means the first call pays for the signature, stores it, and every
 * later call inside the hour finds it. That collapses a queue of twenty-odd
 * MetaMask prompts into one.
 */
let decryptChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = decryptChain.then(fn, fn);
  // Keep the chain alive after a rejection, or one failure stalls every
  // decrypt that follows it.
  decryptChain = run.catch(() => undefined);
  return run;
}

/**
 * Handles whose value is not computed yet, with the time to stop asking until.
 *
 * A pending handle fails the same way every time, and the 20-second poll would
 * otherwise retry it forever. Each retry that reaches a fresh authorization
 * costs a signature, so backing off is a prompt-reduction measure as much as an
 * RPC one.
 */
const pendingUntil = new Map<string, number>();
const PENDING_BACKOFF_MS = 30_000;

/** In-flight decrypts, so the same handle asked for twice waits once. */
const inFlight = new Map<string, Promise<bigint | null>>();

async function tryDecrypt(handle: string): Promise<bigint | null> {
  if (!handle || handle === ZeroHash) return null;

  const hit = decrypted.get(handle);
  if (hit !== undefined) return hit;

  const until = pendingUntil.get(handle);
  if (until !== undefined && Date.now() < until) return null;

  const existing = inFlight.get(handle);
  if (existing) return existing;

  const task = serialize(async () => {
    // The value may have arrived while this call waited its turn in the chain.
    const cached = decrypted.get(handle);
    if (cached !== undefined) return cached;

    const client = await getHandleClient();
    const { value } = await client.decrypt(handle as any);
    const v = BigInt(value as bigint);
    decrypted.set(handle, v);
    pendingUntil.delete(handle);
    return v;
  })
    .catch((e: any) => {
      if (isTransient(e)) {
        pendingUntil.set(handle, Date.now() + PENDING_BACKOFF_MS);
        return null;
      }
      throw e;
    })
    .finally(() => {
      inFlight.delete(handle);
    });

  inFlight.set(handle, task);
  return task;
}

/**
 * Decrypt a handle we are willing to WAIT for.
 *
 * `tryDecrypt` is built for rendering: one attempt, then a 30-second backoff so
 * a poll does not re-ask a pending handle forever. Settlement is the opposite
 * situation — the value is expected to land within seconds, and the answer
 * decides what happens next (whether a remainder is posted, whether the trade
 * executed at all), so here it is worth blocking for.
 *
 * Returns null when it never resolves. A null is "not known", never zero: the
 * caller must not turn silence into a number.
 */
async function awaitDecrypt(handle: string, attempts = 10, delayMs = 3000): Promise<bigint | null> {
  if (!handle || handle === ZeroHash) return null;

  for (let i = 0; i < attempts; i++) {
    const cached = decrypted.get(handle);
    if (cached !== undefined) return cached;

    try {
      const v = await serialize(async () => {
        const client = await getHandleClient();
        const { value } = await client.decrypt(handle as any);
        return BigInt(value as bigint);
      });
      decrypted.set(handle, v);
      pendingUntil.delete(handle);
      return v;
    } catch (e) {
      // Only a transient failure is worth another attempt. A denial or a dead
      // handle will fail identically forever.
      if (!isTransient(e)) return null;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return null;
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

  // The regulator is not a trader, so its ERC-3643 status is noise: the auditor
  // address is deliberately unregistered and would forever read "Not verified",
  // which says nothing true about its authority here. Its powers come from being
  // the address fixed in the contract, not from the investor whitelist.
  el("complianceChip")?.classList.toggle("hidden", role === "auditor");
  el("pairSelect")?.classList.toggle("hidden", role === "auditor");
  syncWalletButton();
  applyColumnWidths();
  void refresh();
}

/**
 * The wallet button exists only when there is a wallet.
 *
 * Disconnected, it opened a panel of dashes: no position to read, no balance to
 * withdraw. Hiding it removes a control that could not do anything, and makes
 * "Connect wallet" the single obvious action in the bar.
 */
function syncWalletButton() {
  const show = !!state.account && state.role !== "auditor";
  el("walletBtn")?.parentElement?.classList.toggle("hidden", !show);
  if (!show) el("walletPanel")?.classList.add("hidden");
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

  // The gateway authorization and its RSA key belong to the address that just
  // left. Decrypted values go with them: they were readable because of a grant
  // this session held, and the next account has no claim on them.
  clearHandleStorage();
  decrypted.clear();
  pendingUntil.clear();
  state.escrow = { cash: null, shares: null };

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
  syncWalletButton();
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
           <li>Inspect the book: order ids, makers, sides and instruments are public; only sizes
           and prices are sealed.</li>
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
  /** 0 = Ask (offering shares), 1 = Bid (offering cash). */
  side: number;
  instrument: number;
  qtyRemaining: string;
  price: string;
  stateCode: number;
  pricePublic: boolean;
}

interface FillRow {
  id: number;
  maker: string;
  taker: string;
  instrument: number;
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
/**
 * Instrument comes off the chain now.
 *
 * `Order` and `Fill` each carry a plaintext `uint8 instrument`, so the venue
 * itself knows which book a resting order belongs to. That replaces an entire
 * layer of guesswork: a localStorage map of what this browser had posted, a
 * shipped map of what the seeding script had posted, and a fallback for
 * everything else — three sources that disagreed the moment an order arrived
 * from a browser that had never seen it.
 *
 * The index is into INSTRUMENTS, which is why the seeding script and the
 * frontend must agree on that order.
 */
const instrumentIndex = () => INSTRUMENTS.indexOf(state.instrument);

const symbolForIndex = (i: number) => INSTRUMENTS[i]?.symbol ?? `instrument ${i}`;

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

/**
 * The book collapses behind a button; once the user toggles it, we stop
 * overriding their choice on connect/disconnect.
 *
 * The filter and sort controls that used to sit beside it are gone. The book is
 * already scoped to the selected instrument and there are rarely more than a
 * handful of rows, so "all / mine / others" and "newest / oldest" were three
 * rows of chrome above three rows of data.
 */
let bookOpen = true;
let bookUserToggled = false;

function setBookOpen(open: boolean) {
  bookOpen = open;
  el("bookPanel")?.classList.toggle("hidden", !open);
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

/**
 * The instrument symbol now comes from the selector, not from a chain read.
 *
 * It used to be resolved off the wrapper's underlying token, which worked while
 * there was exactly one instrument. With three, the selected pair is the answer
 * — and it is available immediately, so the ticker colours correctly on the
 * first paint instead of after a round-trip.
 */
function ensureInstrumentSymbol() {
  state.instrumentSymbol = state.instrument.symbol;
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
        side: Number(o.side),
        instrument: Number(o.instrument),
        qtyRemaining: o.qtyRemaining,
        price: o.price,
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
        instrument: Number(f.instrument),
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
  ensureInstrumentSymbol();
  render();

  // Everything below touches the gateway — fire it without blocking the paint.
  void enrich();
}

/** Off-critical-path: decrypt what we can, then re-render. */
async function enrich() {
  await refreshCompliance();
  await refreshWalletBalances();
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

/**
 * Plaintext wallet balances for both legs.
 *
 * Cheap, public reads — no gateway, no signature, no ciphertext. They are what
 * makes the allocation slider work the instant you connect, instead of waiting
 * on an encrypted escrow balance to resolve, and what the safety guard measures
 * a trade against.
 */
async function refreshWalletBalances() {
  if (!state.account) {
    state.wallet = { cash: null, shares: null };
    return;
  }
  const provider = state.signer ?? readOnlyProvider();

  for (const [leg, address] of [
    // Shares follow the SELECTED instrument, so switching the pair changes what
    // the slider sizes against. Cash is one token across all pairs — everything
    // here quotes against the same cash leg.
    ["shares", state.instrument.token],
    ["cash", CONFIG.cashToken],
  ] as const) {
    if (!address) continue;
    try {
      const token = new Contract(address, ERC20_ABI, provider as any);
      const [raw, decimals] = await Promise.all([
        token.balanceOf(state.account) as Promise<bigint>,
        token.decimals() as Promise<bigint>,
      ]);
      // The venue counts in whole units; the token carries decimals. Divide so
      // a slider percentage means the same thing on both sides of the boundary.
      state.wallet[leg] = raw / 10n ** BigInt(Number(decimals));
    } catch {
      state.wallet[leg] = null;
    }
  }
  renderAllocSource();
  renderSafety();
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
  // The wrapper is per-instrument: each token has its own custody contract, so
  // switching the pair switches which encrypted balance is being shown.
  const wrapperAddress = state.instrument.wrapper || CONFIG.sharesWrapper;
  if (!wrapperAddress || !state.account || !state.nox) return;
  const valueEl = el("wrappedValue");
  const statusEl = el("wrappedStatus");
  const handleEl = el("wrappedHandle");
  const bondEl = el("bondBalance");
  if (!valueEl || !statusEl || !handleEl || !bondEl) return;

  try {
    const provider = state.signer ?? readOnlyProvider();
    const wrapper = new Contract(wrapperAddress, WRAPPER_ABI, provider as any);
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
    renderMark();
    renderSafety();
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

/**
 * An order is open, mid-settlement or cancelled — there is no fourth state.
 *
 * "Expired" used to be one. It is gone with the contract's expiry field: every
 * caller set a lifetime past any horizon that mattered, so nothing ever expired
 * and the row only ever showed a timestamp nobody could act on.
 */
function orderStatusChip(o: OrderRow): string {
  if (o.stateCode === OrderState.PendingResolution) return statusChip("computing", "pending resolution");
  if (o.stateCode === OrderState.Cancelled) return statusChip("failed", "cancelled");
  return statusChip("confirmed", ORDER_STATE_LABEL[o.stateCode] ?? "open");
}

function renderBook() {
  const host = el("book");
  const live = orders.filter(
    (o) => o.stateCode !== OrderState.Cancelled && o.instrument === instrumentIndex(),
  );

  // Count tag on the toggle button reflects the whole live book, not the filter.
  const countEl = el("bookCount");
  if (countEl) countEl.textContent = live.length ? `· ${live.length}` : "";

  if (!host) return;

  if (!state.venue) {
    host.innerHTML = `<p class="empty">Loading the public book…</p>`;
    return;
  }

  // Header line: the instrument and its last public print, so the book is not
  // read without a reference. It is the last PRINT, never a quote — resting
  // prices in this book are ciphertext.
  const last = lastPrint();
  const refEl = el("bookRef");
  if (refEl)
    refEl.textContent = last
      ? `${state.instrument.symbol} · last ${unscale(last.price)}`
      : `${state.instrument.symbol} · no prints yet`;

  if (!live.length) {
    host.innerHTML = `<p class="empty">No ${escapeHtml(state.instrument.symbol)} orders yet. The book is empty — not hidden.</p>`;
    return;
  }

  // Orders carry no timestamp, so id order IS date order — ids are assigned
  // sequentially at post time. Newest first.
  const sorted = [...live].sort((a, b) => b.id - a.id);

  host.innerHTML = sorted
    .map((o) => {
      const mine = o.maker.toLowerCase() === state.account.toLowerCase();
      const pending = o.stateCode === OrderState.PendingResolution;

      const canFill = !mine && !pending && state.compliance.verified === true;

      return `
      <div class="row ${mine ? "mine" : ""}">
        <div class="row-main">
          <div class="row-title">
            <strong>#${o.id}</strong>
            ${orderStatusChip(o)}
            <span class="pill ${o.side === 1 ? "solid" : "muted"}">${o.side === 1 ? "bid" : "ask"}</span>
            ${mine ? `<span class="pill solid">yours</span>` : ""}
            <span class="lock"><svg><use href="#i-lock" /></svg><span>size &amp; price encrypted</span></span>
          </div>
          ${mine ? progressMarkup(o) : ""}
          <div class="row-meta">
            <span>maker ${escapeHtml(shortAddr(o.maker))}</span>
            <span class="mono">qty ${escapeHtml(short(o.qtyRemaining))}</span>
            <span class="mono">px ${escapeHtml(short(o.price))}</span>
          </div>
        </div>
        <div class="actions">
          ${
            mine
              ? ""
              : `<button class="small" data-trade="${o.id}" data-side="${o.side}" data-bucket="${Bucket.LargeInScale}" ${canFill ? "" : "disabled"}
                   data-tip="${
                     canFill
                       ? "Loads this order into the entry terminal, where you set your price, size and visibility delay before signing."
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
  // Scoped to the selected instrument, like the book beside it — a blotter that
  // mixed pairs would not match the column it sits next to.
  const mine = orders.filter(
    (o) => o.maker.toLowerCase() === state.account.toLowerCase() && o.instrument === instrumentIndex(),
  );
  if (!mine.length) {
    host.innerHTML = `<p class="empty">No ${escapeHtml(state.instrument.symbol)} orders of yours.</p>`;
    return;
  }

  host.innerHTML = [...mine]
    .reverse()
    .map((o) => {
      const pending = o.stateCode === OrderState.PendingResolution;
      const cancelled = o.stateCode === OrderState.Cancelled;
      return `
      <div class="row mine">
        <div class="row-main">
          <div class="row-title">
            <strong>#${o.id}</strong>
            ${orderStatusChip(o)}
            <span class="pill muted">${o.side === 1 ? "buy" : "sell"}</span>
            <span class="pill solid" data-tip="Rests until you cancel it. The venue has no order lifetime — nothing expires on its own.">GTC</span>
          </div>
          ${progressMarkup(o)}
          <div class="row-meta">
            <span class="mono">qty ${escapeHtml(short(o.qtyRemaining))}</span>
            <span class="mono">px ${escapeHtml(short(o.price))}</span>
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
  const visible = fills.filter(
    (f) => f.pricePublic && !hiddenFills.has(f.id) && f.instrument === instrumentIndex(),
  );

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

  const session = el("regSession");
  if (session) {
    session.className = isAuditor ? "pill ok" : state.account ? "pill bad" : "pill muted";
    session.textContent = isAuditor
      ? "regulator session"
      : state.account
        ? "not the regulator"
        : "read-only";
  }

  renderExecuted(isAuditor);
  renderAuditorFills(isAuditor);
  renderUnreported();
  void refreshBreaker();
  await renderRegister();
}

/**
 * Every trade that has settled, newest first — the regulator's execution blotter.
 *
 * Distinct from the volumes panel below, which is about the disclosure GAP. This
 * one answers "what has actually traded": counterparties, instrument, price once
 * it has printed, and where each trade sits on its deferral schedule. A trade
 * appears here the moment it settles, whether or not anyone has reported it.
 */
function renderExecuted(isAuditor: boolean) {
  const host = el("auditorExecuted");
  const summary = el("execSummary");
  if (!host) return;

  if (!fills.length) {
    host.innerHTML = `<p class="empty">No trades have settled yet.</p>`;
    if (summary) summary.textContent = "";
    return;
  }

  const reported = fills.filter((f) => f.reported).length;
  const published = fills.filter((f) => f.volumePublished).length;
  if (summary)
    summary.textContent = `${fills.length} settled · ${reported} reported · ${published} volume published`;

  const now = BigInt(Math.floor(Date.now() / 1000));

  host.innerHTML = [...fills]
    .reverse()
    .map((f) => {
      const lis = f.bucket === Bucket.LargeInScale;
      const symbol = symbolForIndex(f.instrument);

      const price =
        f.pricePublic && f.priceValue !== null
          ? `<strong class="mono">${unscale(f.priceValue)}</strong>`
          : `<span class="cipher">price sealed</span>`;

      const size = decrypted.has(f.qty)
        ? `<strong class="mono">${fmt(decrypted.get(f.qty)!)}</strong>`
        : isAuditor
          ? `<button class="small" data-reveal="${f.id}">Reveal size</button>`
          : `<span class="cipher">requires the regulator's grant</span>`;

      // Where this trade sits on its schedule, in plain words.
      let schedule: string;
      if (!f.reported) schedule = statusChip("failed", "never reported");
      else if (f.volumePublished) schedule = statusChip("confirmed", "fully public");
      else if (now >= f.deferredUntil) schedule = statusChip("computing", "due for publication");
      else
        schedule = statusChip(
          "submitted",
          `hidden ${mmss(Number(f.deferredUntil - now))}`,
        );

      return `
      <div class="row">
        <div class="row-main">
          <div class="row-title">
            <strong>trade #${f.id}</strong>
            <span class="pill muted">${escapeHtml(symbol)}</span>
            <span class="pill ${lis ? "warn" : "muted"}">${lis ? "deferred" : "immediate"}</span>
            ${schedule}
          </div>
          <div class="row-meta">
            <span>price ${price}</span>
            <span>size ${size}</span>
          </div>
          <div class="row-meta">
            <span>seller ${escapeHtml(shortAddr(f.maker))}</span>
            <span>buyer ${escapeHtml(shortAddr(f.taker))}</span>
          </div>
        </div>
      </div>`;
    })
    .join("");
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
            <span class="pill ${f.bucket === Bucket.LargeInScale ? "warn" : "muted"}"
              data-tip="${
                f.bucket === Bucket.LargeInScale
                  ? "Deferred schedule: this trade claimed a large-in-scale waiver, so its size is withheld from the public tape for a set period while the price prints at settlement. The claim is a DECLARATION the contract cannot check — the quantity is a ciphertext — which is why you hold the real size from the moment of the fill."
                  : "Immediate schedule: no waiver claimed, so the size becomes public as soon as the maker reports the trade."
              }">${f.bucket === Bucket.LargeInScale ? "Deferred — LIS waiver ⓘ" : "Immediate ⓘ"}</span>
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

type Visibility = "immediate" | "lis" | "never";

/**
 * How this trade's size reaches the public tape.
 *
 * Three choices, and only two of them are an on-chain PARAMETER: `fill` and
 * `hit` take a bucket, and the contract turns it into `now` or
 * `now + LIS_DEFERRAL`. The deferral is a contract CONSTANT — one hour — not a
 * number chosen per trade, so the UI names the length the contract will
 * actually apply rather than offering a timer it cannot honour.
 *
 * "Never" is not a bucket at all. Publication requires the reporting entity to
 * call `reportTrade`, and nothing compels them; skipping it means the size is
 * never published. That is a real and deliberately reachable state — it is
 * exactly what the regulator's unreported list exists to catch — so it is
 * offered honestly rather than dressed up as a timer.
 *
 * Deferred is the DEFAULT. This book is dark for large orders, and publishing a
 * size the instant it settles is the one choice that undoes that.
 */
function visibilityChoice(): Visibility {
  return ((el("entryBucket") as HTMLSelectElement | null)?.value as Visibility) ?? "lis";
}

/** The deferral, as the contract states it. Read at boot; 1h is the constant. */
function deferralLabel(): string {
  const s = Number(state.lisDeferral);
  if (!s) return "deferred";
  if (s % 3600 === 0) return `${s / 3600} hour${s === 3600 ? "" : "s"}`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${s}s`;
}

/** Which leg funds the current side: buys spend cash, sells post shares. */
const fundingLeg = (): "cash" | "shares" => (entry.side === "buy" ? "cash" : "shares");

/**
 * Spendable balance for the current side.
 *
 * Wallet FIRST, escrow as the fallback. Funding is automatic now — placing an
 * order tops escrow up from the wallet if it is short — so the honest ceiling
 * on a trade is what the wallet holds, not what happens to be pre-deposited.
 * Escrow is only the ceiling when the wallet balance cannot be read (no token
 * configured for this instrument).
 */
function spendable(): { amount: bigint | null; source: "wallet" | "escrow" | null } {
  const leg = fundingLeg();
  const w = state.wallet[leg];
  if (w !== null) return { amount: w, source: "wallet" };
  const e = state.escrow[leg];
  if (e !== null) return { amount: e, source: "escrow" };
  return { amount: null, source: null };
}

/**
 * The last PUBLIC print for this instrument — the only price this venue can
 * honestly quote.
 *
 * The book is dark: every resting price is a ciphertext, so there is no best
 * bid or offer to show. What does become public is the price leg of a settled
 * fill, at the moment its maker reports it. That is a reference, and it is
 * labelled as one; it is not a live quote and it is not a mid.
 */
function lastPrint(): { price: bigint; fillId: number } | null {
  for (let i = fills.length - 1; i >= 0; i--) {
    const f = fills[i];
    if (!f.pricePublic || f.priceValue === null) continue;
    if (f.instrument !== instrumentIndex()) continue;
    return { price: f.priceValue, fillId: f.id };
  }
  return null;
}

/**
 * The price to reckon with: a real print if one exists for this instrument,
 * otherwise the instrument's indicative level.
 *
 * The distinction is kept visible everywhere it is shown — a print is something
 * that happened, an indicative is reference data — but for arithmetic (sizing a
 * percentage allocation, seeding the limit field) either is a usable number and
 * having none at all is what makes the control useless.
 */
function referencePrice(): bigint {
  return lastPrint()?.price ?? state.instrument.indicative;
}

/** Scaled integer → human decimal, e.g. 987500 → "98.7500". */
function unscale(v: bigint): string {
  const scale = state.priceScale === 0n ? 10000n : state.priceScale;
  const whole = v / scale;
  const frac = (v % scale).toString().padStart(scale.toString().length - 1, "0");
  return `${whole}.${frac}`;
}

function renderMark() {
  const priceEl = el("markPrice");
  const metaEl = el("markMeta");
  const hintEl = el("priceHint");
  if (!priceEl) return;

  const last = lastPrint();
  const sym = state.instrument.symbol;
  const labelEl = el("markLabel");

  // A print and an indicative are both usable numbers but they are not the same
  // claim, so the label changes with the source rather than blurring them.
  const price = last ? last.price : state.instrument.indicative;
  const kind = last ? "Last print" : "Indicative";

  if (labelEl) labelEl.textContent = kind;
  priceEl.textContent = unscale(price);
  // The PRICE is public once reported, so quoting it is fine. Naming the fill it
  // came from is not: it would tie a published number back to one pair of
  // counterparties, which is more than the tape discloses.
  if (metaEl)
    metaEl.textContent = last
      ? `${sym} · last traded · scaled ${fmt(price)}`
      : `${sym} · reference level, nothing has printed yet`;
  if (hintEl) hintEl.textContent = `${unscale(price)} → ${fmt(price)}`;

  // Same reference wherever the instrument is named, so no panel quotes a
  // different number than its neighbour.
  const ordersRef = el("myOrdersRef");
  if (ordersRef) ordersRef.textContent = `${sym} · ${kind.toLowerCase()} ${unscale(price)}`;

  const bondMark = el("bondMark");
  if (bondMark) bondMark.textContent = `${kind.toLowerCase()} ${unscale(price)}`;

  // Seed the limit field so it is never empty and never wrong for the pair.
  const priceInput = el("entryPrice") as HTMLInputElement | null;
  if (priceInput) priceInput.placeholder = price.toString();
}

function renderAllocSource() {
  const srcEl = el("allocSource");
  const noteEl = el("allocNote");
  if (!srcEl) return;

  const leg = fundingLeg();
  const { amount, source } = spendable();

  if (amount === null) {
    srcEl.textContent = state.account ? `${leg} — resolving` : `${leg} — not connected`;
    if (noteEl)
      noteEl.textContent = state.account
        ? "Balance has not resolved yet. Enter a quantity directly."
        : "";
    return;
  }

  srcEl.textContent = `${fmt(amount)} ${leg}`;
  if (noteEl)
    noteEl.textContent =
      source === "escrow"
        ? `Sizing against escrowed ${leg}; no wallet balance is readable for this leg.`
        : entry.side === "buy"
          ? "Percentage of your wallet cash, converted at the reference price."
          : "Percentage of your wallet holding.";
}

/** Slider/preset → quantity. Buying converts cash to a share count at a price. */
function applyAllocation(pct: number) {
  const qtyEl = el("entryQty") as HTMLInputElement | null;
  const { amount } = spendable();

  // NO TOASTS on this path. Dragging the slider fires `input` continuously, so
  // a toast per event stacked four or five identical cards down the screen. The
  // reason it cannot size is a steady-state fact about the form, not an event,
  // so it belongs in the panel's own note where it can be read once.
  if (!qtyEl || amount === null) {
    const note = el("allocNote");
    if (note)
      note.textContent = state.account
        ? "No readable balance yet for this leg — enter a quantity directly."
        : "Connect a wallet to size against a balance.";
    return;
  }

  if (entry.side === "sell") {
    qtyEl.value = ((amount * BigInt(pct)) / 100n).toString();
    renderSafety();
    return;
  }

  // Buying: cash buys qty = cash × SCALE ÷ price. Prefer the typed limit, then
  // the last public print, then the instrument's indicative price.
  const typed = BigInt((el("entryPrice") as HTMLInputElement)?.value || "0");
  const ref = typed > 0n ? typed : referencePrice();
  if (ref <= 0n) {
    const note = el("allocNote");
    if (note) note.textContent = "Enter a limit price — cash cannot be converted to a size without one.";
    return;
  }
  qtyEl.value = (((amount * BigInt(pct)) / 100n) * state.priceScale / ref).toString();
  renderSafety();
}

// ---------------------------------------------------------------------------
// execution safety guard
// ---------------------------------------------------------------------------

/**
 * Buffer applied to a trade so it cannot fail for want of a rounding unit.
 *
 * The failure it prevents is silent and specific. `fill` computes
 * `need = qty × price ÷ PRICE_SCALE` with integer division and gates the trade
 * on `Nox.transfer`'s success flag, which is just `balance >= need`. Commit
 * every last unit and any rounding leaves you short — the transfer reports
 * false, the quantity is selected to zero, and the trade settles for NOTHING
 * with no revert and no error to read, because a revert would leak the
 * shortfall. A reverted or zeroed attempt is also where trade parameters can
 * leak to anyone watching the mempool, which is the MEV exposure this warns
 * about.
 */
const BUFFER_BPS = 50n; // 0.5%

/**
 * The price this order will actually transact at.
 *
 * A limit order transacts at the price the trader typed. A MARKET order has no
 * typed price, so it transacts at the edge of the collar — the worst level it
 * is willing to accept. That is the number to fund against and to rest any
 * unfilled remainder at, because it is the only price the order commits to.
 */
function executionPrice(): bigint {
  if (entry.type === "market") {
    const ref = referencePrice();
    return entry.side === "buy" ? collarBuy(ref) : collarSell(ref);
  }
  return BigInt((el("entryPrice") as HTMLInputElement)?.value || "0");
}

/** What the trade needs in the funding leg, at the price actually being used. */
function requiredFunding(qty: bigint): bigint {
  if (entry.side === "sell") return qty;
  // A market buy funds the TOP of the collar, since that is the most it can be
  // charged. Funding the reference instead would leave every fill above it
  // silently settling for zero — the exact failure this form exists to prevent.
  const price = executionPrice();
  if (price <= 0n) return 0n;
  return (qty * price) / state.priceScale;
}

const withBuffer = (amount: bigint): bigint => amount + (amount * BUFFER_BPS) / 10_000n;

/**
 * Warns when a trade leaves no room for execution overhead.
 *
 * Non-blocking on purpose: it never disables the submit button. The user may
 * have a reason, and a guard that refuses is a guard people route around.
 */
function renderSafety() {
  const box = el("safetyWarning");
  const note = el("fundingNote");
  if (!box) return;

  const qty = BigInt((el("entryQty") as HTMLInputElement)?.value || "0");
  const { amount, source } = spendable();

  if (qty <= 0n || amount === null || amount === 0n) {
    box.classList.add("hidden");
    if (note) note.textContent = "";
    return;
  }

  const need = requiredFunding(qty);
  if (need <= 0n) {
    box.classList.add("hidden");
    if (note) note.textContent = "";
    return;
  }

  // Trip when the trade consumes the balance with less than the buffer to spare.
  box.classList.toggle("hidden", withBuffer(need) <= amount);

  if (note) {
    const leg = fundingLeg();
    note.textContent =
      need > amount
        ? `This order needs ${fmt(need)} ${leg} and your ${source} holds ${fmt(amount)}. It will be submitted, but an underfunded order settles for zero rather than failing.`
        : `Commits ${fmt(need)} of ${fmt(amount)} ${leg}. Escrow is topped up automatically when you submit.`;
  }
}

/**
 * Quantity and notional are two views of one decision, so editing either
 * derives the other at the working price.
 *
 * `notional = qty × price ÷ 1e4` is the contract's own arithmetic, so the amount
 * shown is what settlement will actually move rather than an approximation.
 * The guard prevents the two handlers ping-ponging: writing one input fires its
 * sibling's `input` event in some browsers.
 */
let syncingAmounts = false;

function syncFromQty() {
  if (syncingAmounts) return;
  const qty = BigInt((el("entryQty") as HTMLInputElement)?.value || "0");
  const price = workingPrice();
  const out = el("entryNotional") as HTMLInputElement | null;
  if (!out || price <= 0n) return;
  syncingAmounts = true;
  out.value = qty > 0n ? ((qty * price) / state.priceScale).toString() : "";
  syncingAmounts = false;
  renderSafety();
}

function syncFromNotional() {
  if (syncingAmounts) return;
  const notional = BigInt((el("entryNotional") as HTMLInputElement)?.value || "0");
  const price = workingPrice();
  const out = el("entryQty") as HTMLInputElement | null;
  if (!out || price <= 0n) return;
  syncingAmounts = true;
  out.value = notional > 0n ? ((notional * state.priceScale) / price).toString() : "";
  syncingAmounts = false;
  renderSafety();
}

/** The price the form is working at: what it will transact at, else the reference. */
function workingPrice(): bigint {
  const price = executionPrice();
  return price > 0n ? price : referencePrice();
}

/** Shrinks the quantity until the buffer fits. */
function adjustForBuffer() {
  const qtyEl = el("entryQty") as HTMLInputElement | null;
  const qty = BigInt(qtyEl?.value || "0");
  if (!qtyEl || qty <= 0n) return;

  // Take the buffer off the quantity itself: for a sell the quantity IS the
  // committed amount, and for a buy the notional is linear in it, so the same
  // reduction leaves the same proportional headroom either way.
  const reduced = qty - (qty * BUFFER_BPS) / 10_000n - 1n;
  qtyEl.value = (reduced > 0n ? reduced : 0n).toString();
  renderSafety();
  toast("ok", "Amount adjusted", `Reduced by 0.5% so execution overhead cannot zero the settlement.`);
}

/** Repaint the terminal for the current side and order type. */
function renderEntry() {
  const buy = entry.side === "buy";
  const market = entry.type === "market";

  // One attribute repaints everything that should agree with the side. The
  // alternative — every component checking the side for itself — is how a UI
  // ends up half green and half red.
  document.documentElement.dataset.side = entry.side;

  el("sideBuy")?.classList.toggle("on", buy);
  el("sideSell")?.classList.toggle("on", !buy);
  el("sideBuy")?.setAttribute("aria-pressed", String(buy));
  el("sideSell")?.setAttribute("aria-pressed", String(!buy));

  document
    .querySelectorAll<HTMLElement>("[data-ordertype]")
    .forEach((n) => n.classList.toggle("on", n.dataset.ordertype === entry.type));


  // A market order has no price to state — it takes whatever the book gives —
  // so the field is removed rather than shown disabled and empty.
  const priceEl = el("entryPrice") as HTMLInputElement | null;
  el("priceField")?.classList.toggle("hidden", market);
  if (priceEl) {
    priceEl.disabled = market;
    priceEl.required = !market;
  }
  const priceLabel = el("priceLabel");
  if (priceLabel) priceLabel.textContent = "Target price";

  // A market order in a dark book still has to state a worst acceptable price,
  // so say what it is. The number is the actual encrypted bid or ask the trade
  // will carry, not a rule of thumb.
  const collarNote = el("collarNote");
  if (collarNote) {
    if (market) {
      const limit = buy ? collarBuy(referencePrice()) : collarSell(referencePrice());
      collarNote.textContent =
        `Executes within ${Number(COLLAR_BPS) / 100}% of the reference — ` +
        `${buy ? "paying no more than" : "receiving no less than"} ${unscale(limit)}. ` +
        `Outside that band the trade settles for zero rather than at a bad price.`;
    } else {
      collarNote.textContent = "";
    }
  }

  const submit = el("entrySubmit") as HTMLButtonElement | null;
  if (submit) {
    submit.textContent = buy
      ? market
        ? "Buy at market"
        : "Buy — limit"
      : market
        ? "Sell at market"
        : "Post sell offer";
    submit.classList.toggle("submit-buy", buy);
    submit.classList.toggle("submit-sell", !buy);
    submit.disabled = false;
  }

  // ONE set of choices for both sides. The taker of a trade declares the bucket
  // — that is true whichever way the trade goes, since `fill` and `hit` both
  // take it from whoever calls them — so a buyer lifting an ask and a seller
  // hitting a bid have exactly the same control, and there is no reason for the
  // menu to change under them.
  el("bucketField")?.classList.remove("hidden");
  const bucketSel = el("entryBucket") as HTMLSelectElement | null;
  if (bucketSel) {
    const keep = bucketSel.value || "lis";
    bucketSel.innerHTML = `
      <option value="immediate">Immediate — size public on report</option>
      <option value="lis">${deferralLabel()} — large-in-scale waiver</option>
      <option value="never">Never — do not publish the size</option>`;
    bucketSel.value = ["immediate", "lis", "never"].includes(keep) ? keep : "lis";
  }

  // An order that RESTS discloses nothing yet: it has not traded, so there is no
  // size to publish and the choice above only takes effect when someone takes
  // it. Saying so beats letting the control look inert.
  const bucketNote = el("bucketNote");
  if (bucketNote) {
    const resting = buy ? !pickTarget() : !pickBid();
    bucketNote.textContent =
      !market && resting
        ? "Nothing to take right now, so this order will rest. The delay applies to whoever trades against it."
        : "";
  }

  const unit = el("qtyUnit");
  if (unit) unit.textContent = state.instrument.symbol;
  const nUnit = el("notionalUnit");
  if (nUnit) nUnit.textContent = state.instrument.quote;

  renderTargetOptions();
  renderAllocSource();
  renderMark();
  renderSafety();
}

/**
 * Orders the connected account may hit, for the selected instrument.
 *
 * Excludes its own: `fill` rejects a self-fill outright, because with maker ==
 * taker both sides of the cash transfer resolve to one storage slot.
 */
function openOrders(side: number): OrderRow[] {
  const acct = state.account.toLowerCase();
  return orders.filter(
    (o) =>
      o.side === side &&
      o.stateCode === OrderState.Open &&
      o.instrument === instrumentIndex() &&
      (!acct || o.maker.toLowerCase() !== acct),
  );
}

/** Asks a buyer can lift. */
const hittableOrders = (): OrderRow[] => openOrders(0);

/** Bids a seller can hit — the side that only exists since the redeploy. */
function pickBid(): OrderRow | null {
  const bids = openOrders(1);
  return bids.length ? bids.reduce((a, b) => (a.id <= b.id ? a : b)) : null;
}

/**
 * Picks which resting order a buy lifts, without asking.
 *
 * Choosing a counterparty is an artefact of this venue being RFQ — each order
 * is one dealer's quote rather than a level in an aggregated book — and it is
 * not a decision a trader can make informedly anyway: sizes and prices are
 * ciphertext, so every option looks identical. The oldest hittable order is
 * taken first, which is the price-time priority any exchange would apply if it
 * could read the prices.
 */
function pickTarget(): OrderRow | null {
  const hittable = hittableOrders();
  if (!hittable.length) return null;
  return hittable.reduce((a, b) => (a.id <= b.id ? a : b));
}

/** Keeps the hidden select in sync, so the submit path has an id to read. */
function renderTargetOptions() {
  const sel = el("targetOrder") as HTMLSelectElement | null;
  if (!sel) return;
  const hittable = hittableOrders();
  sel.innerHTML = hittable.map((o) => `<option value="${o.id}">#${o.id}</option>`).join("");
  const chosen = pickTarget();
  if (chosen) sel.value = String(chosen.id);
}

/**
 * Tops escrow up to cover this order, inline, before it is placed.
 *
 * This is what replaced the manual "Fund escrow" card. It cannot be replaced by
 * pulling from the wallet at settlement instead: `postAsk` and `fill` move value
 * out of `escrowShares` / `escrowCash`, and the venue has no path that touches a
 * wallet. Escrow is also *where the encrypted balance lives* — a per-trade pull
 * of an exact amount would publish the trade size on-chain and end the
 * confidentiality the venue exists to provide.
 *
 * So the deposit still happens; it just happens for you, sized to the order,
 * with the buffer already applied, and only when the existing balance is short.
 */
async function ensureFunded(need: bigint): Promise<boolean> {
  const leg = fundingLeg();
  const have = state.escrow[leg];

  // A resolved balance that already covers it needs nothing. An UNRESOLVED one
  // is not treated as zero: depositing on top of an unknown balance is safe
  // (escrow only ever adds), whereas assuming zero would be inventing a number.
  if (have !== null && have >= need) return true;

  const shortfall = have === null ? need : need - have;
  const amount = withBuffer(shortfall);

  const ok = await asyncAction(
    {
      button: el("entrySubmit") as HTMLButtonElement,
      label: `Fund ${leg}`,
      async: true,
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

  if (ok === undefined) return false;

  // The deposit minted a fresh handle, so the cached decryption is stale.
  state.escrow[leg] = null;
  return true;
}

/**
 * Rests an order on the book and remembers its size locally.
 *
 * The remembered size is what draws the partial-fill bar: `qtyRemaining` is a
 * ciphertext and the original is never stored on-chain, so remaining/original
 * cannot be reconstructed from contract state. Recording the number the user
 * typed is legitimate — it is their own order and their own plaintext — and
 * failing to record it degrades the bar to "size sealed", never to a guess.
 */
async function restOrder(side: Side, qty: bigint, price: bigint, label: string): Promise<boolean> {
  const done = await asyncAction(
    { button: el("entrySubmit") as HTMLButtonElement, label, async: true, onSettled: refresh },
    async () => {
      const q = await encryptInput(qty, CONFIG.venue);
      const p = await encryptInput(price, CONFIG.venue);
      const tx =
        side === "buy"
          ? await state.venue!.postBid(instrumentIndex(), q.handle, p.handle, q.proof, p.proof)
          : await state.venue!.postAsk(instrumentIndex(), q.handle, p.handle, q.proof, p.proof);
      const receipt = await tx.wait();
      try {
        const id = (await count("orders")) - 1;
        if (id >= 0) rememberPosted(id, qty);
      } catch {
        /* progress bar degrades to "size sealed" — never to a guess */
      }
      return receipt;
    },
  );
  return done !== undefined;
}

/**
 * What actually filled, and what to do with what did not.
 *
 * A taker asks for a size; the contract fills `min(wanted, qtyRemaining)` and
 * zeroes the whole thing if the price did not cross. Neither outcome reverts —
 * a revert would leak the size or the price the caller was not entitled to
 * learn — so from the outside a partial fill, a full fill and a trade that did
 * nothing at all look identical.
 *
 * The taker CAN read the answer: `fill` and `hit` both grant them a viewer role
 * on the executed quantity. So this decrypts it and then does the two things
 * the old flow left to the user: it says plainly what executed, and it rests
 * the unfilled remainder as a real order instead of quietly dropping it.
 */
async function settleTaker(opts: {
  wanted: bigint;
  price: bigint;
  side: Side;
  market: boolean;
}): Promise<void> {
  const { wanted, price, side, market } = opts;

  const fillId = (await count("fills")) - 1;
  if (fillId < 0) return;

  let qtyHandle = "";
  try {
    qtyHandle = (await state.venue!.fills(fillId)).qty;
  } catch {
    return;
  }

  const executed = await awaitDecrypt(qtyHandle);

  if (executed === null) {
    toast(
      "info",
      "Execution still resolving",
      "The TEE has not published your fill size yet, so no remainder was posted. Re-enter the balance of the order once it lands.",
    );
    return;
  }

  if (executed === 0n) {
    toast(
      "error",
      "Nothing executed",
      market
        ? `The resting price was outside your ${Number(COLLAR_BPS) / 100}% collar, so the trade settled for zero. Nothing was paid.`
        : "Your limit did not cross the resting price, so the trade settled for zero. Nothing was paid.",
      11000,
    );
  } else if (executed < wanted) {
    toast(
      "ok",
      "Partially executed",
      `${fmt(executed)} of ${fmt(wanted)} traded. Resting the remaining ${fmt(wanted - executed)} on the book.`,
    );
  } else {
    toast("ok", "Executed in full", `${fmt(executed)} traded.`);
    return;
  }

  const remainder = wanted - executed;
  if (remainder <= 0n || price <= 0n) return;

  // The remainder becomes a resting order on the SAME side the trader wanted:
  // an unfilled buy rests as a bid, an unfilled sell rests as an ask. It rests
  // at the price the order committed to — the typed limit, or the collar edge
  // for a market order, which is the worst level it already accepted.
  const funded = side === "buy" ? (remainder * price) / state.priceScale : remainder;
  if (funded > 0n && !(await ensureFunded(funded))) return;

  await restOrder(side, remainder, price, side === "buy" ? "Rest remaining bid" : "Rest remaining offer");
}

async function onEntrySubmit(e: Event) {
  e.preventDefault();
  if (!requireReady()) return;

  const qty = BigInt((el("entryQty") as HTMLInputElement)?.value || "0");
  if (qty <= 0n) {
    toast("error", "Quantity must be positive");
    return;
  }

  const market = entry.type === "market";
  const price = executionPrice();
  if (price <= 0n) {
    toast(
      "error",
      market ? "No reference price" : "Target price must be positive",
      market ? "Nothing has printed in this instrument and it has no indicative level." : undefined,
    );
    return;
  }

  // Fund first, in the same flow, so there is no separate deposit step.
  const need = requiredFunding(qty);
  if (need > 0n && !(await ensureFunded(need))) return;

  const bucket = visibilityChoice() === "immediate" ? Bucket.Standard : Bucket.LargeInScale;

  if (entry.side === "buy") {
    const chosen = pickTarget();

    // MARKET BUY, or a limit with something to lift: take a resting ask.
    if (market || chosen) {
      if (!chosen) {
        toast(
          "error",
          "Nothing offered",
          `No resting offers in ${state.instrument.symbol} to buy from. Post a limit bid instead.`,
        );
        return;
      }
      const done = await asyncAction(
        {
          button: el("entrySubmit") as HTMLButtonElement,
          label: market ? "Market buy" : "Limit buy",
          async: true,
          onSettled: refresh,
        },
        async () => {
          // The bid is the CEILING, not the price paid: settlement charges
          // `qty × the ask ÷ SCALE`. For a market order that ceiling is the
          // collar, which is what stops an absurd resting quote being lifted.
          const b = await encryptInput(price, CONFIG.venue);
          const q = await encryptInput(qty, CONFIG.venue);
          const tx = await state.venue!.fill(BigInt(chosen.id), b.handle, q.handle, b.proof, q.proof, bucket);
          return tx.wait();
        },
      );
      if (done !== undefined) await settleTaker({ wanted: qty, price, side: "buy", market });
      return;
    }

    // LIMIT BUY with nothing to lift: rest a real bid.
    await restOrder("buy", qty, price, "Post bid");
    return;
  }

  // ---- sell ----
  const restingBid = pickBid();

  // A sell takes a resting bid when there is one — at market, or on a limit
  // that may cross. Otherwise it rests as an ask. Same decision an exchange
  // makes on arrival.
  if (restingBid) {
    const done = await asyncAction(
      {
        button: el("entrySubmit") as HTMLButtonElement,
        label: market ? "Market sell" : "Limit sell",
        async: true,
        onSettled: refresh,
      },
      async () => {
        // The ask is the FLOOR. At market that floor is the collar rather than
        // 1, which is what stops the sale going through at any price at all.
        const a = await encryptInput(price, CONFIG.venue);
        const q = await encryptInput(qty, CONFIG.venue);
        const tx = await state.venue!.hit(BigInt(restingBid.id), a.handle, q.handle, a.proof, q.proof, bucket);
        return tx.wait();
      },
    );
    if (done !== undefined) await settleTaker({ wanted: qty, price, side: "sell", market });
    return;
  }

  if (market) {
    toast(
      "error",
      "No bids to hit",
      `Nobody is bidding for ${state.instrument.symbol} right now. Post a limit offer instead.`,
    );
    return;
  }

  await restOrder("sell", qty, price, "Post sell offer");
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

/**
 * Loads a book row into the entry terminal instead of filling it inline.
 *
 * The old path asked for bid and size through two `window.prompt` calls, which
 * is not how anyone trades and gave no chance to see the balance being spent.
 * A book row is now a route into the terminal, where the order type, bucket and
 * allocation are all visible before anything is signed.
 */
function loadIntoTerminal(orderId: number, orderSide: number) {
  // Trading against an ASK means buying; against a BID it means selling. The
  // row used to force "buy" whichever side it was, which was right while the
  // book only had asks in it.
  entry.side = orderSide === 1 ? "sell" : "buy";
  entry.type = "limit";
  renderEntry();

  // The visibility choice stays whatever the trader last set. Overwriting it
  // from the row was a leftover from when the button carried a bucket: the row
  // never knew anything about how this trader wants their size disclosed.
  const sel = el("targetOrder") as HTMLSelectElement | null;
  if (sel) sel.value = String(orderId);

  el("colEntry")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  (el("entryQty") as HTMLInputElement | null)?.focus();
}

/**
 * Take a balance out of VENUE ESCROW.
 *
 * This is where the proceeds of a sale actually sit. Settlement does not send
 * anyone tokens: `fill` and `hit` move value between `escrowCash` and
 * `escrowShares` inside the venue, as ciphertext, and it stays there until it
 * is withdrawn. The contract has had `withdrawCash` / `withdrawShares` since
 * the two-sided redeploy; nothing in the UI called them, so escrow could only
 * be emptied by trading it away.
 *
 * Asking for more than is held moves ZERO rather than reverting — the same
 * branchless discipline as settlement, for the same reason: a revert would
 * confirm the size of a balance the venue is not supposed to disclose. So the
 * balance shown above the form is the honest guide, and the result is read back
 * from the escrow tile rather than announced here.
 */
async function onEscrowWithdraw(e: Event) {
  e.preventDefault();
  if (!requireReady()) return;

  const raw = (el("escrowWithdrawAmount") as HTMLInputElement)?.value;
  const amount = BigInt(raw || "0");
  if (amount <= 0n) {
    toast("error", "Amount must be positive");
    return;
  }

  const leg = ((el("escrowWithdrawLeg") as HTMLSelectElement | null)?.value ?? "cash") as
    | "cash"
    | "shares";

  const held = state.escrow[leg];
  if (held !== null && amount > held) {
    toast(
      "error",
      "More than you hold",
      `Escrow holds ${fmt(held)} ${leg}. A larger withdrawal does not revert — it moves nothing.`,
    );
    return;
  }

  await asyncAction(
    {
      button: document.querySelector<HTMLButtonElement>(`[data-async="escrow-withdraw"]`),
      label: `Withdraw ${leg} from escrow`,
      async: true,
      onSettled: refresh,
    },
    async () => {
      const enc = await encryptInput(amount, CONFIG.venue);
      const tx =
        leg === "cash"
          ? await state.venue!.withdrawCash(enc.handle, enc.proof)
          : await state.venue!.withdrawShares(enc.handle, enc.proof);
      const receipt = await tx.wait();
      // The withdrawal minted a fresh handle, so the cached decryption is stale.
      state.escrow[leg] = null;
      return receipt;
    },
  );
}

/**
 * Unwrap — releases a hidden balance back to plaintext tokens.
 *
 * The step AFTER escrow withdrawal, and a different boundary: escrow lives in
 * the venue, the hidden balance lives in the ERC-7984 wrapper. It is genuinely
 * two transactions because of what confidentiality costs. `requestUnwrap` locks
 * the amount and publishes ONLY a success flag: whether the balance covered it,
 * never what the balance was. `claimUnwrap` then releases the tokens against a
 * gateway proof of that flag. A single-call unwrap would have to reveal the
 * balance to decide whether it could succeed.
 */
async function onWithdraw(e: Event) {
  e.preventDefault();
  if (!state.signer) {
    toast("error", "Connect a wallet first");
    return;
  }
  const wrapperAddress = state.instrument.wrapper;
  if (!wrapperAddress) {
    toast("error", `No wrapper deployed for ${state.instrument.symbol}`);
    return;
  }

  const raw = (el("withdrawAmount") as HTMLInputElement)?.value;
  if (!raw || Number(raw) <= 0) {
    toast("error", "Amount must be positive");
    return;
  }

  const note = el("withdrawNote");

  await asyncAction(
    {
      button: document.querySelector<HTMLButtonElement>(`[data-async="withdraw"]`),
      label: `Withdraw ${state.instrument.symbol}`,
      async: true,
      onSettled: refresh,
    },
    async () => {
      const wrapper = new Contract(wrapperAddress, WRAPPER_ABI, state.signer!);
      const token = new Contract(await wrapper.underlying(), ERC20_ABI, state.signer!);
      const decimals: bigint = await token.decimals();
      const amount = parseUnits(raw, Number(decimals));

      const tx = await wrapper.requestUnwrap(amount);
      const receipt = await tx.wait();

      if (note)
        note.textContent =
          "Request submitted. The success flag is resolving in the TEE; claim the tokens once it lands.";
      return receipt;
    },
  );
}

async function onWrap(e: Event) {
  e.preventDefault();
  if (!state.signer) {
    toast("error", "Connect a wallet first");
    return;
  }
  const wrapperAddress = state.instrument.wrapper || CONFIG.sharesWrapper;
  if (!wrapperAddress) {
    toast("error", `No wrapper deployed for ${state.instrument.symbol}`);
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
    {
      button: document.querySelector<HTMLButtonElement>(`[data-async="wrap"]`),
      label: `Hide ${state.instrument.symbol}`,
      onSettled: refresh,
    },
    async () => {
      const wrapper = new Contract(wrapperAddress, WRAPPER_ABI, state.signer!);
      const bond = new Contract(await wrapper.underlying(), ERC20_ABI, state.signer!);
      const decimals: bigint = await bond.decimals();
      const amount = parseUnits(raw, Number(decimals));

      // wrap() pulls via transferFrom, so the approval must be mined first.
      const approval = await bond.approve(wrapperAddress, amount);
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
    loadIntoTerminal(Number(tradeBtn.dataset.trade), Number(tradeBtn.dataset.side));
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
$("wrapForm").addEventListener("submit", (e) => void onWrap(e));
el("withdrawForm")?.addEventListener("submit", (e) => void onWithdraw(e));
el("escrowWithdrawForm")?.addEventListener("submit", (e) => void onEscrowWithdraw(e));
$("entryForm").addEventListener("submit", (e) => void onEntrySubmit(e));

// --- instrument selector
{
  const sel = el("pairSelect") as HTMLSelectElement | null;
  if (sel) {
    sel.innerHTML = INSTRUMENTS.map(
      (i, idx) => `<option value="${idx}">${escapeHtml(pairLabel(i))}</option>`,
    ).join("");
    sel.title =
      "All three instruments are deployed and share one IdentityRegistry. Each has its own book: DeferralVenue.Order carries a plaintext instrument index, so orders and prints are separated by pair.";
    sel.addEventListener("change", () => {
      state.instrument = INSTRUMENTS[Number(sel.value)] ?? INSTRUMENTS[0];
      for (const id of ["bondSymbol", "withdrawSymbol"]) {
        const n = el(id);
        if (n) n.textContent = state.instrument.symbol;
      }

      // Balances and the encrypted wrapper handle are per-instrument, so they
      // are stale the moment the pair changes.
      state.wallet = { cash: null, shares: null };
      ensureInstrumentSymbol();
      renderEntry();
      tickerSignature = "";
      render();
      void enrich();
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

el("allocRange")?.addEventListener("input", (e) => {
  const pct = Number((e.target as HTMLInputElement).value);
  const out = el("allocPct");
  if (out) out.textContent = `${pct}%`;
  applyAllocation(pct);
});

el("entryBucket")?.addEventListener("change", renderEntry);

// Quantity and amount are two views of one number — editing either derives the
// other at the working price.
el("entryQty")?.addEventListener("input", syncFromQty);
el("entryNotional")?.addEventListener("input", syncFromNotional);

// --- execution safety guard: re-evaluate on anything that moves the maths
el("entryPrice")?.addEventListener("input", () => {
  // Changing the price changes what a percentage of the wallet BUYS, so an
  // allocation already chosen has to be re-derived. Without this, moving the
  // slider to 50% and then editing the price left a quantity that was 50% of
  // nothing in particular.
  const pct = Number((el("allocRange") as HTMLInputElement)?.value ?? 0);
  if (pct > 0) applyAllocation(pct);
  else syncFromQty();
  renderSafety();
});
el("safetyAdjust")?.addEventListener("click", adjustForBuffer);

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

// --- order book: collapse behind the history button
el("bookToggle")?.addEventListener("click", () => {
  bookUserToggled = true;
  setBookOpen(el("bookPanel")?.classList.contains("hidden") ?? true);
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
