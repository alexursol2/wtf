/**
 * Deferral Venue frontend.
 *
 * Two design rules drive this file.
 *
 * 1. OPTIMISTIC-WITH-PENDING IS STRUCTURAL, NOT COSMETIC. Nox is TEE-async: a
 *    transaction commits, then an off-chain Ingestor and Runner decrypt inside
 *    Intel TDX, compute, re-encrypt and store. So a confirmed transaction does
 *    NOT mean a value exists yet. Every write goes through `submit()`, which
 *    shows a pending row from the moment it is sent and only clears it once the
 *    receipt lands — and even then labels downstream values as unresolved.
 *
 * 2. NEVER INVENT A NUMBER. Encrypted balances cannot be read on-chain, and
 *    decryption needs the Nox handle SDK plus the gateway. Where a plaintext
 *    value is unavailable, this UI shows the handle and its real, on-chain
 *    disclosure state (isPubliclyDecryptable / isViewer) instead of a
 *    placeholder. A published price is genuinely public and could be decrypted
 *    by anyone; an unpublished one is shown as private, not as zero.
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
import { VENUE_ABI, NOX_ABI, WRAPPER_ABI, ERC20_ABI } from "./abi.js";
import { CONFIG, NOX_COMPUTE, CHAIN_NAMES, ORDER_STATE_LABEL, OrderState, Bucket } from "./config.js";

// ---------------------------------------------------------------------------
// element helpers
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const short = (h: string) => (h && h !== ZeroHash ? `${h.slice(0, 10)}…${h.slice(-6)}` : "—");
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Thousands separators. These are integers — the scale is applied separately. */
const fmt = (v: bigint) => v.toLocaleString("en-US");

/** mm:ss for the deferral countdown. Clamped at zero. */
function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function banner(message: string, kind: "error" | "info" | "ok" = "info") {
  const el = $("banner");
  el.textContent = message;
  el.className = `banner ${kind}`;
}

function clearBanner() {
  $("banner").className = "banner hidden";
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

interface Pending {
  id: number;
  label: string;
}

const state = {
  provider: null as BrowserProvider | null,
  signer: null as JsonRpcSigner | null,
  account: "",
  chainId: 0,
  venue: null as Contract | null,
  nox: null as Contract | null,
  handleClient: null as HandleClient | null,
  /** Which account the cached handle client is bound to. See getHandleClient. */
  handleClientFor: "" as string,
  priceScale: 10000n,
  lisDeferral: 90n,
  auditor: "",
  view: "market" as "market" | "auditor",
  pending: [] as Pending[],
  pendingSeq: 0,
};

/**
 * Wraps a write. The pending row appears immediately and survives until the
 * receipt lands — this is the async-lag surface the user must be able to see,
 * because a confirmed transaction still has unresolved encrypted results.
 */
async function submit(label: string, fn: () => Promise<any>) {
  const p: Pending = { id: ++state.pendingSeq, label };
  state.pending.push(p);
  render();
  try {
    const tx = await fn();
    await tx.wait();
    banner(`${label} confirmed. Encrypted results resolve asynchronously — values may lag.`, "ok");
  } catch (err: any) {
    // Surface the contract's own reason. These are all plaintext gates
    // (identity, expiry, state) — an encrypted shortfall never reverts.
    const reason =
      err?.reason ??
      err?.shortMessage ??
      err?.info?.error?.message ??
      err?.message ??
      "transaction failed";
    banner(`${label} failed: ${reason}`, "error");
  } finally {
    state.pending = state.pending.filter((x) => x.id !== p.id);
    await refresh();
  }
}

// ---------------------------------------------------------------------------
// encrypted inputs
// ---------------------------------------------------------------------------

/**
 * Encrypted inputs need a handle minted by the Nox gateway plus a 137-byte
 * EIP-712 proof binding (handle, owner, app). Only the gateway can produce
 * those, so this cannot be stubbed — the venue calls validateInputProof and an
 * unproven handle reverts on-chain.
 *
 * The SDK ships built-in configuration for Ethereum Sepolia and Arbitrum
 * Sepolia (gateway, NoxCompute address, subgraph), so no URL is required on
 * those chains; VITE_NOX_GATEWAY_URL only overrides it.
 *
 * The `app` binding is the CONTRACT that will call fromExternal, not the user.
 * Passing the wallet address instead reverts with "App mismatch".
 */
function handleConfigOverride(): any {
  const override: Record<string, string> = {};
  const gatewayUrl = (import.meta.env as any).VITE_NOX_GATEWAY_URL;
  const subgraphUrl = (import.meta.env as any).VITE_NOX_SUBGRAPH_URL;
  if (gatewayUrl) override.gatewayUrl = gatewayUrl;
  if (subgraphUrl) override.subgraphUrl = subgraphUrl;
  return Object.keys(override).length > 0 ? override : undefined;
}

/**
 * The handle client is cached AGAINST THE ACCOUNT IT BELONGS TO, never on its
 * own. That distinction is load-bearing.
 *
 * A plain `if (cached) return cached` is wrong here, and wrong in a way that
 * fails far from its cause. The page loads read-only, so the tape renders
 * without a wallet — and that read path builds a client bound to a throwaway
 * random wallet. Cache it unconditionally and it survives the user connecting
 * MetaMask, so `encryptInput` goes on minting proofs owned by an address nobody
 * controls. The gateway signs them happily; the contract then rejects them at
 * validateInputProof with a bare custom error, during gas estimation, so the
 * wallet never even opens. Reads fail too, because that random address holds no
 * viewer grant.
 *
 * Keying on the account makes the stale case unrepresentable.
 */
async function getHandleClient(): Promise<HandleClient> {
  const wanted = state.account || "readonly";
  if (state.handleClient && state.handleClientFor === wanted) return state.handleClient;

  if (state.signer) {
    state.handleClient = await createEthersHandleClient(state.signer as any, handleConfigOverride());
    state.handleClientFor = wanted;
    return state.handleClient;
  }

  // Read-only mode. Published prices and volumes are PUBLIC by design, so
  // reading the tape must not require a wallet — a regulator or a passer-by
  // should be able to check the prints. The SDK insists on a client bound to an
  // account even for publicDecrypt, so we hand it a throwaway random wallet: it
  // holds nothing, is never funded, and never signs a transaction.
  const ephemeral = Wallet.createRandom().connect(readOnlyProvider());
  state.handleClient = await createEthersHandleClient(ephemeral as any, handleConfigOverride());
  state.handleClientFor = wanted;
  return state.handleClient;
}

/** Provider for reads when no wallet is connected. */
function readOnlyProvider(): JsonRpcProvider {
  const url =
    (import.meta.env as any).VITE_RPC_URL ??
    (CONFIG.expectedChainId === 421614
      ? "https://arbitrum-sepolia-rpc.publicnode.com"
      : "https://ethereum-sepolia-rpc.publicnode.com");
  return new JsonRpcProvider(url, CONFIG.expectedChainId);
}

/**
 * Loads the venue read-only so the public tape renders before any wallet is
 * connected. Deliberately does NOT touch escrow balances — those need a viewer
 * grant, which needs a real signer.
 */
async function connectReadOnly() {
  if (!CONFIG.venue || !CONFIG.expectedChainId) return;

  const provider = readOnlyProvider();
  const noxAddress = NOX_COMPUTE[CONFIG.expectedChainId];
  if (!noxAddress) return;

  state.venue = new Contract(CONFIG.venue, VENUE_ABI, provider);
  state.nox = new Contract(noxAddress, NOX_ABI, provider);

  try {
    state.priceScale = await state.venue.PRICE_SCALE();
    state.lisDeferral = await state.venue.LIS_DEFERRAL();
    state.auditor = await state.venue.auditor();
    $("priceScale").textContent = state.priceScale.toString();
    $("deferralSeconds").textContent = state.lisDeferral.toString();
  } catch {
    return; // leave the UI in its disconnected state
  }

  $("netLabel").textContent = `${CHAIN_NAMES[CONFIG.expectedChainId]} · read-only`;
  $("netLabel").className = "pill";
  await refresh();
}

async function encryptInput(value: bigint): Promise<{ handle: string; proof: string }> {
  const client = await getHandleClient();
  const { handle, handleProof } = await client.encryptInput(value, "uint256", CONFIG.venue as any);
  return { handle, proof: handleProof };
}

/**
 * Decrypts a handle the connected wallet holds a grant on. Returns null while
 * the value is still unresolved — Nox is TEE-async, so "not yet computed" is a
 * normal transient state, not an error, and must not be shown as a failure.
 */
async function tryDecrypt(handle: string): Promise<bigint | null> {
  if (!handle || handle === ZeroHash) return null;
  try {
    const client = await getHandleClient();
    const { value } = await client.decrypt(handle as any);
    return BigInt(value as bigint);
  } catch (e: any) {
    if (isTransient(e)) return null;
    throw e;
  }
}

/**
 * True when a decrypt failure means "wait", not "denied".
 *
 * Three transient classes, and only two are exported from the SDK.
 * `SubgraphOutOfSyncError` is thrown but not exported, so it cannot be caught by
 * `instanceof` and has to be matched on its message — and it fires on a lag as
 * small as one block. Treating it as fatal makes a perfectly readable value look
 * permanently unavailable, which is exactly the confusion this UI must avoid.
 */
function isTransient(e: any): boolean {
  if (e instanceof NotYetComputedHandleError || e instanceof UnknownHandleError) return true;
  if (e?.constructor?.name === "SubgraphOutOfSyncError") return true;
  const m = e?.message ?? "";

  // "not a viewer" (HTTP 403) is genuinely ambiguous: the gateway says it both
  // when the grant is absent and when it exists on-chain but has not been
  // indexed yet. Same words, opposite meanings. Treating it as fatal makes a
  // freshly-granted balance read as permanently unreadable, so the UI shows it
  // as pending — the on-chain isViewer check upstream is what decides whether a
  // grant exists at all, and that is authoritative.
  return /not yet computed|unknown handle|out of sync|not a viewer|access_denied/i.test(m);
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

  // Drop anything built for a previous identity — including the read-only
  // client created at page load, which is bound to a throwaway wallet.
  state.handleClient = null;
  state.handleClientFor = "";

  const noxAddress = NOX_COMPUTE[state.chainId];
  if (!noxAddress) {
    banner(
      `Chain ${state.chainId} has no NoxCompute deployment. Switch to Ethereum Sepolia, ` +
        `Arbitrum Sepolia, or a local node — anything else reverts "Nox: Unsupported chain".`,
      "error",
    );
    return;
  }
  if (CONFIG.expectedChainId && state.chainId !== CONFIG.expectedChainId) {
    banner(
      `Connected to ${CHAIN_NAMES[state.chainId] ?? state.chainId} but the configured ` +
        `deployment is on ${CHAIN_NAMES[CONFIG.expectedChainId] ?? CONFIG.expectedChainId}.`,
      "error",
    );
    return;
  }
  if (!CONFIG.venue) {
    banner(
      "No venue address configured. Deploy the Nox sub-project and set VITE_VENUE " +
        "(see deployments/venue.*.json).",
      "error",
    );
    return;
  }

  state.venue = new Contract(CONFIG.venue, VENUE_ABI, state.signer);
  state.nox = new Contract(noxAddress, NOX_ABI, state.provider);

  setConnectedChrome();

  try {
    state.priceScale = await state.venue.PRICE_SCALE();
    state.lisDeferral = await state.venue.LIS_DEFERRAL();
    state.auditor = await state.venue.auditor();
    $("priceScale").textContent = state.priceScale.toString();
    // Read the deferral off the contract rather than hardcoding it in the
    // caption — the on-screen number must match what the chain will enforce.
    $("deferralSeconds").textContent = state.lisDeferral.toString();
  } catch {
    banner("Could not read the venue — is VITE_VENUE correct for this chain?", "error");
    return;
  }

  clearBanner();
  await refresh();
}

/**
 * Drops this site's session and returns to the public read-only view.
 *
 * Two things make this more than a cosmetic button.
 *
 * First, EVERY piece of account-derived state has to go together — signer,
 * account, and above all the cached handle client. Leaving that client behind is
 * precisely the bug that made the connected write path fail: a client bound to
 * one identity, reused under another, mints proofs the contract rejects with an
 * opaque custom error during gas estimation. Clearing them as a set is what
 * keeps that from recurring in reverse.
 *
 * Second, be honest about what this is. A dapp cannot log you out of MetaMask —
 * only the wallet can revoke that. Newer MetaMask exposes
 * `wallet_revokePermissions`, so we ask for a real revoke where it exists and
 * fall back to clearing our own session where it does not. Either way the tape
 * keeps working, because published prints are public and never needed a wallet.
 */
async function disconnect() {
  const eth = (window as any).ethereum;

  // Ask the wallet to actually revoke, where supported. Failure is expected on
  // older MetaMask and is not worth surfacing — the local clear below is the
  // part that matters.
  try {
    await eth?.request?.({
      method: "wallet_revokePermissions",
      params: [{ eth_accounts: {} }],
    });
  } catch {
    /* not supported — clearing our own session is still correct */
  }

  state.provider = null;
  state.signer = null;
  state.account = "";
  state.chainId = 0;
  state.handleClient = null;
  state.handleClientFor = "";

  // Values decrypted under the old identity must not linger. Public prints are
  // safe to keep — they are public — but anything read with a viewer grant is
  // not ours to display any more.
  for (const [id, text] of [
    ["cashHandle", "—"],
    ["cashState", "no handle yet"],
    ["sharesHandle", "—"],
    ["sharesState", "no handle yet"],
    ["bondBalance", "—"],
    ["wrappedHandle", "—"],
    ["wrappedState", "no handle yet"],
  ] as const) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = text;
      if (id.endsWith("State")) el.className = "pill muted";
    }
  }

  $("connect").classList.remove("hidden");
  $("connect").textContent = "Connect wallet";
  $("disconnect").classList.add("hidden");

  banner("Disconnected. The public tape stays readable — prints do not need a wallet.", "info");

  // Back to the read-only view rather than a blank page.
  await connectReadOnly();
}

/** Reflects a live connection in the header. */
function setConnectedChrome() {
  $("netLabel").textContent = `${CHAIN_NAMES[state.chainId] ?? state.chainId} · ${shortAddr(state.account)}`;
  $("netLabel").className = "pill ok";
  $("connect").classList.add("hidden");
  $("disconnect").classList.remove("hidden");
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
  /** Plaintext, once publicly decryptable. null while private OR while the
   *  gateway's indexer is still catching up — the two are indistinguishable
   *  from the client, so neither is ever rendered as a number. */
  priceValue: bigint | null;
  volumeValue: bigint | null;
}

/**
 * Public values, cached by handle.
 *
 * Worth caching for two reasons: a published price never changes, and the
 * countdown re-renders every second — refetching through the gateway on each
 * tick would hammer it for no reason.
 */
const publicValues = new Map<string, bigint>();

/**
 * Reads a handle that has been marked publicly decryptable. Anyone can do this;
 * that is the point of publication. Returns null while the gateway has not yet
 * served it, which happens for a few seconds after allowPublicDecryption because
 * its indexer trails the chain.
 */
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

let orders: OrderRow[] = [];
let fills: FillRow[] = [];

/**
 * Counts come from the contract, not from logs.
 *
 * Scanning events was the obvious approach and does not survive a hosted RPC:
 * Alchemy's free tier rejects any eth_getLogs wider than 10 blocks, so
 * `queryFilter(filter, 0, "latest")` fails outright. The Nox subgraph is no help
 * either — it indexes Nox handles, not this contract's events. So the venue
 * exposes ordersCount()/fillsCount() and we page by index.
 */
async function enumerate(which: "orders" | "fills"): Promise<number> {
  if (!state.venue) return 0;
  try {
    const count = which === "orders" ? await state.venue.ordersCount() : await state.venue.fillsCount();
    return Number(count);
  } catch {
    return 0;
  }
}

async function refresh() {
  if (!state.venue || !state.nox) {
    render();
    return;
  }

  const [orderCount, fillCount] = await Promise.all([enumerate("orders"), enumerate("fills")]);

  const nextOrders: OrderRow[] = [];
  for (let i = 0; i < orderCount; i++) {
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
      /* order index gone — skip */
    }
  }

  const nextFills: FillRow[] = [];
  for (let i = 0; i < fillCount; i++) {
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
        // Only fetch what is genuinely public. Asking for a private handle
        // would fail anyway, and the tape must never show a withheld number.
        priceValue: pricePublic ? await tryPublicDecrypt(f.price) : null,
        volumeValue: volumePublic ? await tryPublicDecrypt(f.qty) : null,
      });
    } catch {
      /* skip */
    }
  }

  orders = nextOrders;
  fills = nextFills;

  await refreshOwnPosition();
  await refreshWrapper();
  render();
}

async function isPublic(handle: string): Promise<boolean> {
  if (!state.nox || !handle || handle === ZeroHash) return false;
  try {
    return await state.nox.isPubliclyDecryptable(handle);
  } catch {
    return false;
  }
}

async function refreshOwnPosition() {
  // Escrow balances need a viewer grant, which needs a real signer. In
  // read-only mode there is no "own" position to show.
  if (!state.venue || !state.nox || !state.account) return;

  for (const [kind, handleEl, stateEl] of [
    ["cash", "cashHandle", "cashState"],
    ["shares", "sharesHandle", "sharesState"],
  ] as const) {
    try {
      const handle: string =
        kind === "cash"
          ? await state.venue.escrowCash(state.account)
          : await state.venue.escrowShares(state.account);

      $(handleEl).textContent = short(handle);

      if (!handle || handle === ZeroHash) {
        $(stateEl).textContent = "no handle yet";
        $(stateEl).className = "pill muted";
        continue;
      }

      // A viewer grant is what makes the balance decryptable off-chain. Its
      // absence is the classic dead-handle bug and must be visible, not silent.
      const canView = await state.nox.isViewer(handle, state.account);
      if (!canView) {
        $(stateEl).textContent = "no viewer grant";
        $(stateEl).className = "pill warn";
        continue;
      }

      // Actually decrypt it. A null result means the Runner has not resolved
      // the handle yet — a normal transient state under TEE-async execution,
      // shown as pending rather than as an error or as a zero.
      const value = await tryDecrypt(handle);
      if (value === null) {
        $(stateEl).textContent = "resolving…";
        $(stateEl).className = "pill warn";
      } else {
        $(handleEl).textContent = value.toString();
        $(stateEl).textContent = "decrypted (only you can)";
        $(stateEl).className = "pill ok";
      }
    } catch {
      $(handleEl).textContent = "—";
      $(stateEl).textContent = "read failed";
      $(stateEl).className = "pill warn";
    }
  }
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

function render() {
  renderPending();
  renderBook();
  renderTape();
  if (state.view === "auditor") void renderAuditor();
}

// ---------------------------------------------------------------------------
// auditor route
// ---------------------------------------------------------------------------

function setView(view: "market" | "auditor") {
  state.view = view;
  $("viewMarket").classList.toggle("hidden", view !== "market");
  $("viewAuditor").classList.toggle("hidden", view !== "auditor");
  $("tabMarket").classList.toggle("active", view === "market");
  $("tabAuditor").classList.toggle("active", view === "auditor");
  render();
}

/**
 * Renders the regulator's view against the public's, for the same fills at the
 * same moment.
 *
 * The left column is only populated when the connected wallet actually holds the
 * viewer grant — this page cannot and must not fake privileged access. If you
 * open it as anyone else, the left column stays sealed, which is itself the
 * demonstration.
 */
async function renderAuditor() {
  const isAuditor =
    state.account !== "" && state.account.toLowerCase() === state.auditor.toLowerCase();

  $("auditorIdentity").innerHTML = !state.account
    ? `Read-only. Connect the auditor wallet (<code>${state.auditor ? shortAddr(state.auditor) : "?"}</code>) to decrypt volumes.`
    : isAuditor
      ? `Connected as the auditor (<code>${shortAddr(state.account)}</code>). The left column below is decrypted with grants this address holds.`
      : `Connected as <code>${shortAddr(state.account)}</code>, which is <strong>not</strong> the auditor
         (<code>${shortAddr(state.auditor)}</code>). The left column stays sealed — that is the protocol, not this page.`;

  renderAuditorFills(isAuditor);
  renderUnreported();
  await renderRegister();

  // Decrypting is a network round trip per handle, so do it after the structure
  // is on screen and fill the values in as they arrive.
  if (isAuditor) void fillAuditorValues();
}

function renderAuditorFills(isAuditor: boolean) {
  const el = $("auditorFills");
  if (fills.length === 0) {
    el.innerHTML = `<p class="empty">No fills yet.</p>`;
    return;
  }

  el.innerHTML = [...fills]
    .reverse()
    .map((f) => {
      const publicSees = f.volumePublic
        ? f.volumeValue !== null
          ? fmt(f.volumeValue)
          : "published, resolving…"
        : f.reported
          ? "withheld — deferred"
          : "nothing, unreported";

      // A gap exists whenever the regulator can see a size the public cannot.
      const gapOpen = !f.volumePublic;

      const regulatorCell = isAuditor
        ? `<span class="tape-value" id="audvol-${f.id}">decrypting…</span>`
        : `<span class="tape-value private">requires the auditor's grant</span>`;

      return `
        <div class="row ${gapOpen ? "gap-open" : ""}">
          <div class="row-main">
            <div class="row-title">
              <strong>fill #${f.id}</strong>
              <span class="pill ${f.bucket === Bucket.LargeInScale ? "warn" : "muted"}">${
                f.bucket === Bucket.LargeInScale ? "large in scale" : "standard"
              }</span>
              ${gapOpen ? `<span class="pill warn">gap open</span>` : `<span class="pill muted">public caught up</span>`}
            </div>
            <div class="gap-grid">
              <div class="gap-cell regulator">
                <label>regulator sees</label>
                ${regulatorCell}
              </div>
              <div class="gap-cell public">
                <label>public sees</label>
                <span class="tape-value ${f.volumePublic ? "pub" : "private"}">${publicSees}</span>
              </div>
            </div>
            <div class="row-meta">
              <span>maker ${shortAddr(f.maker)}</span>
              <span>taker ${shortAddr(f.taker)}</span>
            </div>
          </div>
        </div>`;
    })
    .join("");
}

/** Decrypts each fill volume with the auditor's own grants. */
async function fillAuditorValues() {
  for (const f of fills) {
    const node = document.getElementById(`audvol-${f.id}`);
    if (!node) continue;
    const v = await tryDecrypt(f.qty);
    const current = document.getElementById(`audvol-${f.id}`);
    if (!current) continue; // re-rendered underneath us
    if (v === null) {
      current.textContent = "not yet resolved";
      current.className = "tape-value pending";
    } else {
      current.textContent = fmt(v);
      current.className = "tape-value";
    }
  }
}

/**
 * Fills that settled but were never reported.
 *
 * This is the detectable-not-preventable story made concrete: the contract has
 * no way to compel a maker to print a trade, but the auditor was granted the
 * quantity at fill time, so an omission is visible rather than invisible.
 */
function renderUnreported() {
  const el = $("auditorUnreported");
  const unreported = fills.filter((f) => !f.reported);

  if (unreported.length === 0) {
    el.innerHTML = `<p class="empty">Every settled fill has been reported.</p>`;
    return;
  }

  el.innerHTML = [...unreported]
    .reverse()
    .map(
      (f) => `
        <div class="row unreported">
          <div class="row-main">
            <div class="row-title">
              <strong>fill #${f.id}</strong>
              <span class="pill pub">no print submitted</span>
            </div>
            <div class="row-meta">
              <span>reporting entity ${shortAddr(f.maker)}</span>
              <span>taker ${shortAddr(f.taker)}</span>
              <span class="muted">visible to the regulator, not preventable by the contract</span>
            </div>
          </div>
        </div>`,
    )
    .join("");
}

/** Register access is per-holder and granted by the issuer, never automatic. */
async function renderRegister() {
  const el = $("auditorRegister");

  if (!CONFIG.sharesWrapper) {
    el.innerHTML = `<p class="empty">Set VITE_SHARES_WRAPPER to inspect the holder register.</p>`;
    return;
  }
  if (!state.auditor) {
    el.innerHTML = `<p class="empty">Connect to load the register.</p>`;
    return;
  }

  // Holders worth checking: whoever appears in the book or the tape.
  const holders = [...new Set([...orders.map((o) => o.maker), ...fills.flatMap((f) => [f.maker, f.taker])])];
  if (holders.length === 0) {
    el.innerHTML = `<p class="empty">No holders on record yet.</p>`;
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
      granted = await state.nox!.isViewer(handle, state.auditor);
    } catch {
      /* leave false */
    }

    rows.push(`
      <div class="row">
        <div class="row-main">
          <div class="row-title">
            <strong>${shortAddr(holder)}</strong>
            <span class="pill ${granted ? "ok" : "muted"}">${
              granted ? "disclosed to the auditor" : "sealed"
            }</span>
          </div>
          <div class="row-meta">
            <span>balance <code class="handle">${short(handle)}</code></span>
            <span>${
              granted
                ? "the issuer granted access to this holder"
                : "the issuer has not disclosed this holder"
            }</span>
          </div>
        </div>
      </div>`);
  }

  el.innerHTML = rows.length
    ? rows.join("")
    : `<p class="empty">No wrapped balances yet — nothing in the register to disclose.</p>`;
}

function renderPending() {
  const existing = document.getElementById("pendingStrip");
  if (existing) existing.remove();
  if (state.pending.length === 0) return;

  const strip = document.createElement("div");
  strip.id = "pendingStrip";
  strip.className = "pending-strip";
  strip.innerHTML = state.pending
    .map((p) => `<span class="pending"><span class="spinner"></span>${p.label}</span>`)
    .join("");
  document.querySelector("main")!.prepend(strip);
}

function renderBook() {
  const el = $("book");

  if (!state.venue) {
    el.innerHTML = `<p class="empty">Connect a wallet to load the book.</p>`;
    return;
  }
  const live = orders.filter((o) => o.stateCode !== OrderState.Cancelled);
  if (live.length === 0) {
    el.innerHTML = `<p class="empty">No orders yet. The book is empty — not hidden.</p>`;
    return;
  }

  const now = BigInt(Math.floor(Date.now() / 1000));

  el.innerHTML = live
    .map((o) => {
      const mine = o.maker.toLowerCase() === state.account.toLowerCase();
      const expired = o.expiry <= now;
      const pending = o.stateCode === OrderState.PendingResolution;

      const badges = [
        `<span class="pill ${pending ? "warn" : "ok"}">${ORDER_STATE_LABEL[o.stateCode]}</span>`,
        expired ? `<span class="pill warn">expired</span>` : "",
        mine ? `<span class="pill">yours</span>` : "",
        o.pricePublic ? `<span class="pill pub">price public</span>` : `<span class="pill muted">price private</span>`,
      ]
        .filter(Boolean)
        .join("");

      // Cancel is blocked while a fill is unresolved — a cancel racing an
      // unresolved fill is a real bug class under async settlement.
      const actions = mine
        ? `<div class="actions">
             <button data-cancel="${o.id}" ${pending ? "disabled" : ""} title="${
               pending ? "blocked while a fill is unresolved" : "reclaim the remainder"
             }">Cancel</button>
             ${pending ? `<button data-reopen="${o.id}">Reopen</button>` : ""}
           </div>`
        : `<div class="actions">
             <button data-fill="${o.id}" data-bucket="${Bucket.LargeInScale}" ${
               expired || pending ? "disabled" : ""
             }>Fill (LIS)</button>
             <button data-fill="${o.id}" data-bucket="${Bucket.Standard}" ${
               expired || pending ? "disabled" : ""
             }>Fill (standard)</button>
           </div>`;

      return `
        <div class="row">
          <div class="row-main">
            <div class="row-title">
              <strong>#${o.id}</strong>
              <span class="muted">${shortAddr(o.maker)}</span>
              ${badges}
            </div>
            <div class="row-meta">
              <span>qty <code class="handle">${short(o.qtyRemaining)}</code></span>
              <span>price <code class="handle">${short(o.price)}</code></span>
              <span>expires ${new Date(Number(o.expiry) * 1000).toLocaleTimeString()}</span>
            </div>
          </div>
          ${actions}
        </div>`;
    })
    .join("");

  el.querySelectorAll<HTMLButtonElement>("[data-cancel]").forEach((b) =>
    b.addEventListener("click", () =>
      submit(`Cancel order #${b.dataset.cancel}`, () => state.venue!.cancel(BigInt(b.dataset.cancel!))),
    ),
  );
  el.querySelectorAll<HTMLButtonElement>("[data-reopen]").forEach((b) =>
    b.addEventListener("click", () =>
      submit(`Reopen order #${b.dataset.reopen}`, () => state.venue!.reopen(BigInt(b.dataset.reopen!))),
    ),
  );
  el.querySelectorAll<HTMLButtonElement>("[data-fill]").forEach((b) =>
    b.addEventListener("click", () => onFill(Number(b.dataset.fill), Number(b.dataset.bucket))),
  );
}

function renderTape() {
  const el = $("tape");

  if (!state.venue) {
    el.innerHTML = `<p class="empty">Connect a wallet to load the tape.</p>`;
    return;
  }
  if (fills.length === 0) {
    el.innerHTML = `<p class="empty">No prints yet.</p>`;
    return;
  }

  const now = BigInt(Math.floor(Date.now() / 1000));

  // Newest print first — a tape reads top-down.
  el.innerHTML = [...fills]
    .reverse()
    .map((f) => {
      const isMaker = f.maker.toLowerCase() === state.account.toLowerCase();
      const lis = f.bucket === Bucket.LargeInScale;
      const deferralPassed = f.reported && now >= f.deferredUntil;
      const secondsLeft = f.reported ? Number(f.deferredUntil - now) : 0;

      // --- price: published at settlement, so show the real number ---
      const priceCell = f.pricePublic
        ? f.priceValue !== null
          ? `<span class="tape-value pub">${fmt(f.priceValue)}</span>`
          : `<span class="tape-value pending">published, resolving…</span>`
        : `<span class="tape-value private">withheld</span>`;

      // --- volume: the whole point. Countdown while deferred. ---
      let volumeCell: string;
      if (f.volumePublic) {
        volumeCell =
          f.volumeValue !== null
            ? `<span class="tape-value pub">${fmt(f.volumeValue)}</span>`
            : `<span class="tape-value pending">published, resolving…</span>`;
      } else if (!f.reported) {
        volumeCell = `<span class="tape-value private">unreported</span>`;
      } else if (deferralPassed) {
        volumeCell = `<span class="tape-value ready">publishable now</span>`;
      } else {
        volumeCell = `<span class="tape-value countdown" data-countdown="${f.deferredUntil}">volume in ${mmss(secondsLeft)}</span>`;
      }

      // Notional only makes sense once BOTH halves are public — which is
      // precisely the asymmetry the deferral creates, so show the gap rather
      // than filling it in.
      const notional =
        f.priceValue !== null && f.volumeValue !== null
          ? `<span>notional <strong>${fmt((f.volumeValue * f.priceValue) / state.priceScale)}</strong></span>`
          : `<span class="muted">notional unknown until volume prints</span>`;

      // Reporting is the maker's act — they are the reporting entity. An
      // unreported fill is visible to the auditor but not preventable here.
      const actions: string[] = [];
      if (isMaker && !f.reported) actions.push(`<button data-report="${f.id}">Report trade</button>`);
      if (f.reported && !f.volumePublished)
        actions.push(
          `<button data-publish="${f.id}" ${deferralPassed ? "" : "disabled"}>Publish volume</button>`,
        );

      return `
        <div class="row tape-row">
          <div class="row-main">
            <div class="row-title">
              <strong>fill #${f.id}</strong>
              <span class="pill ${lis ? "warn" : "muted"}">${lis ? "large in scale" : "standard"}</span>
              ${f.reported ? "" : `<span class="pill muted">not yet reported</span>`}
            </div>
            <div class="tape-grid">
              <div><label>price</label>${priceCell}</div>
              <div><label>volume</label>${volumeCell}</div>
            </div>
            <div class="row-meta">
              <span>maker ${shortAddr(f.maker)}</span>
              <span>taker ${shortAddr(f.taker)}</span>
              ${notional}
            </div>
          </div>
          <div class="actions">${actions.join("")}</div>
        </div>`;
    })
    .join("");

  el.querySelectorAll<HTMLButtonElement>("[data-report]").forEach((b) =>
    b.addEventListener("click", () =>
      submit(`Report fill #${b.dataset.report}`, () =>
        state.venue!.reportTrade(BigInt(b.dataset.report!)),
      ),
    ),
  );
  el.querySelectorAll<HTMLButtonElement>("[data-publish]").forEach((b) =>
    b.addEventListener("click", () =>
      submit(`Publish volume for fill #${b.dataset.publish}`, () =>
        state.venue!.publishVolume(BigInt(b.dataset.publish!)),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// actions needing encrypted input
// ---------------------------------------------------------------------------

/**
 * Funds the venue's encrypted escrow.
 *
 * This has to exist for the venue to be usable at all: escrow lives in the venue
 * as raw handles, and posting an ask without shares behind it produces an order
 * that settles for zero rather than one that fails loudly — because reverting on
 * an encrypted shortfall would leak it.
 */
async function onDeposit(e: Event) {
  e.preventDefault();
  if (!state.venue || !state.signer) {
    banner("Connect a wallet first.", "error");
    return;
  }

  const amount = BigInt(($("depositAmount") as HTMLInputElement).value || "0");
  const leg = ($("depositLeg") as HTMLSelectElement).value as "cash" | "shares";
  if (amount <= 0n) {
    banner("Deposit amount must be positive.", "error");
    return;
  }

  await submit(`Deposit ${leg}`, async () => {
    const enc = await encryptInput(amount);
    return leg === "cash"
      ? state.venue!.depositCash(enc.handle, enc.proof)
      : state.venue!.depositShares(enc.handle, enc.proof);
  });
}

/**
 * Wraps plaintext T-REX bonds into a confidential balance — the Layer 2 custody
 * boundary. Two transactions: approve, then wrap. The amount is public here by
 * construction; see the note in the UI.
 */
async function onWrap(e: Event) {
  e.preventDefault();
  if (!state.signer) {
    banner("Connect a wallet first.", "error");
    return;
  }
  if (!CONFIG.sharesWrapper) {
    banner("VITE_SHARES_WRAPPER is not configured.", "error");
    return;
  }

  const raw = ($("wrapAmount") as HTMLInputElement).value;
  if (!raw || Number(raw) <= 0) {
    banner("Wrap amount must be positive.", "error");
    return;
  }

  await submit("Wrap bonds", async () => {
    const wrapper = new Contract(CONFIG.sharesWrapper, WRAPPER_ABI, state.signer!);
    const bond = new Contract(await wrapper.underlying(), ERC20_ABI, state.signer!);
    const decimals: bigint = await bond.decimals();
    const amount = parseUnits(raw, Number(decimals));

    // Approve first and wait for it — wrap() pulls via transferFrom, so an
    // un-mined approval makes the wrap revert on allowance.
    const approval = await bond.approve(CONFIG.sharesWrapper, amount);
    await approval.wait();

    return wrapper.wrap(amount);
  });
}

/** Public ERC-20 balance and the confidential balance beside it. */
async function refreshWrapper() {
  if (!CONFIG.sharesWrapper || !state.account || !state.nox) return;

  try {
    const provider = state.signer ?? readOnlyProvider();
    const wrapper = new Contract(CONFIG.sharesWrapper, WRAPPER_ABI, provider as any);
    const bond = new Contract(await wrapper.underlying(), ERC20_ABI, provider as any);

    const [decimals, bal] = await Promise.all([
      bond.decimals() as Promise<bigint>,
      bond.balanceOf(state.account) as Promise<bigint>,
    ]);
    $("bondBalance").textContent = `${formatUnits(bal, Number(decimals))}`;

    const handle: string = await wrapper.balanceHandle(state.account);
    if (!handle || handle === ZeroHash) {
      $("wrappedHandle").textContent = "—";
      $("wrappedState").textContent = "nothing wrapped yet";
      $("wrappedState").className = "pill muted";
      return;
    }

    const canView = await state.nox.isViewer(handle, state.account);
    if (!canView) {
      $("wrappedHandle").textContent = short(handle);
      $("wrappedState").textContent = "no viewer grant";
      $("wrappedState").className = "pill warn";
      return;
    }

    const value = await tryDecrypt(handle);
    if (value === null) {
      $("wrappedHandle").textContent = short(handle);
      $("wrappedState").textContent = "resolving…";
      $("wrappedState").className = "pill warn";
    } else {
      $("wrappedHandle").textContent = formatUnits(value, Number(decimals));
      $("wrappedState").textContent = "decrypted (only you can)";
      $("wrappedState").className = "pill ok";
    }
  } catch {
    $("bondBalance").textContent = "—";
    $("wrappedState").textContent = "read failed";
    $("wrappedState").className = "pill warn";
  }
}

async function onPost(e: Event) {
  e.preventDefault();
  if (!state.venue) {
    banner("Connect a wallet first.", "error");
    return;
  }

  const qty = BigInt(($("qty") as HTMLInputElement).value || "0");
  const price = BigInt(($("price") as HTMLInputElement).value || "0");
  const minutes = BigInt(($("expiry") as HTMLInputElement).value || "60");
  if (qty <= 0n || price <= 0n) {
    banner("Quantity and price must both be positive.", "error");
    return;
  }

  const expiry = BigInt(Math.floor(Date.now() / 1000)) + minutes * 60n;

  await submit("Post ask", async () => {
    const q = await encryptInput(qty);
    const p = await encryptInput(price);
    return state.venue!.postAsk(q.handle, p.handle, q.proof, p.proof, expiry);
  });
}

async function onFill(orderId: number, bucket: number) {
  if (!state.venue) return;

  const bidRaw = window.prompt("Your bid price (scaled, e.g. 987500):");
  if (!bidRaw) return;
  const qtyRaw = window.prompt("Quantity you want:");
  if (!qtyRaw) return;

  await submit(`Fill order #${orderId}`, async () => {
    const bid = await encryptInput(BigInt(bidRaw));
    const qty = await encryptInput(BigInt(qtyRaw));
    return state.venue!.fill(BigInt(orderId), bid.handle, qty.handle, bid.proof, qty.proof, bucket);
  });
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

$("tabMarket").addEventListener("click", () => setView("market"));
$("tabAuditor").addEventListener("click", () => setView("auditor"));

$("depositForm").addEventListener("submit", (e) => onDeposit(e).catch((e) => banner(e.message, "error")));
$("wrapForm").addEventListener("submit", (e) => onWrap(e).catch((e) => banner(e.message, "error")));

$("connect").addEventListener("click", () => connect().catch((e) => banner(e.message, "error")));
$("disconnect").addEventListener("click", () => disconnect().catch((e) => banner(e.message, "error")));
$("postForm").addEventListener("submit", (e) => onPost(e).catch((e) => banner(e.message, "error")));

/**
 * The wallet can change identity underneath us with no click of ours, which is
 * the same hazard as a stale cache: a handle client bound to the old account
 * would go on minting proofs the contract rejects. Rebuild on account change,
 * and reload on chain change — a provider's chain is fixed at construction.
 */
{
  const eth = (window as any).ethereum;
  eth?.on?.("accountsChanged", (accounts: string[]) => {
    if (!accounts || accounts.length === 0) {
      void disconnect();
    } else if (accounts[0].toLowerCase() !== state.account.toLowerCase()) {
      void connect().catch((e) => banner(e.message, "error"));
    }
  });
  eth?.on?.("chainChanged", () => window.location.reload());
}

/**
 * Two separate clocks, deliberately.
 *
 * The countdown ticks every second, but only rewrites the text of existing
 * countdown elements — it does not re-render or hit the chain. A full refresh
 * every second would spam the RPC and the gateway, and would also fight with
 * whatever the user is doing.
 *
 * When a countdown reaches zero the volume becomes publishable, which IS a state
 * change, so that single transition triggers one real refresh.
 */
setInterval(() => {
  const nodes = document.querySelectorAll<HTMLElement>("[data-countdown]");
  if (nodes.length === 0) return;

  const now = Math.floor(Date.now() / 1000);
  let anyElapsed = false;

  nodes.forEach((node) => {
    const until = Number(node.dataset.countdown);
    const left = until - now;
    if (left <= 0) {
      anyElapsed = true;
    } else {
      node.textContent = `volume in ${mmss(left)}`;
    }
  });

  // The deferral just elapsed — re-read so the publish button enables.
  if (anyElapsed && state.venue) void refresh();
}, 1_000);

// Slower poll so another party's actions show up without a reload.
setInterval(() => {
  if (state.venue) void refresh();
}, 20_000);

if (!CONFIG.venue) {
  banner(
    "No deployment configured. Run the deploy scripts, then set VITE_VENUE (and VITE_CHAIN_ID) — " +
      "addresses are written to deployments/venue.*.json.",
    "info",
  );
  render();
} else {
  // Load the public tape immediately. Prints are public by design, so they
  // should not be gated behind a wallet connection.
  render();
  void connectReadOnly().catch(() => {
    /* stays in the disconnected state; the Connect button still works */
  });
}
