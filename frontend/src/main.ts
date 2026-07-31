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

type Role = "trader" | "maker" | "auditor";

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
  role: "trader" as Role,
  compliance: {
    verified: null as boolean | null,
    country: 0,
    countryGateActive: false,
    countryAllowed: true,
  },
};

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
 * Roles are navigation because the three see genuinely different data, and the
 * auditor gets an inverted theme so the difference is legible at a glance.
 *
 * Be precise about what this is, though: the CONTRACT does not know about
 * "trader" and "maker". Any verified address may post or fill, and you become a
 * maker by posting. Only the auditor is a protocol-level role, fixed at
 * deployment and enforced by grants. This switch shapes what you are shown; it
 * does not grant anything.
 */
function setRole(role: Role) {
  state.role = role;
  document.documentElement.dataset.role = role;

  for (const [id, r] of [
    ["viewTrader", "trader"],
    ["viewMaker", "maker"],
    ["viewAuditor", "auditor"],
  ] as const) {
    el(id)?.classList.toggle("hidden", role !== r);
  }
  document.querySelectorAll<HTMLButtonElement>(".role").forEach((b) => {
    b.classList.toggle("active", b.dataset.role === role);
  });

  void refresh();
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
  await refresh();
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
  await refresh();
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

    if (!verified) {
      chip.className = "pill bad";
      chip.textContent = "not verified";
    } else if (gateActive && !allowed) {
      chip.className = "pill warn";
      chip.textContent = `country ${country} restricted`;
    } else {
      chip.className = "pill ok";
      chip.textContent = `verified · country ${country}`;
    }
  } catch {
    chip.className = "pill muted";
    chip.textContent = "compliance unknown";
  }

  renderComplianceNotice();
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

  for (const id of ["complianceNotice", "complianceNoticeMaker"]) {
    const n = el(id);
    if (n) n.innerHTML = html;
  }
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

async function isPublic(handle: string): Promise<boolean> {
  if (!state.nox || !handle || handle === ZeroHash) return false;
  try {
    return await state.nox.isPubliclyDecryptable(handle);
  } catch {
    return false;
  }
}

async function refresh() {
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
        priceValue: pricePublic ? await tryPublicDecrypt(f.price) : null,
        volumeValue: volumePublic ? await tryPublicDecrypt(f.qty) : null,
      });
    } catch {
      /* skip */
    }
  }

  orders = nextOrders;
  fills = nextFills;

  await refreshCompliance();
  await refreshPosition();
  await refreshWrapper();
  render();
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
      }
    } catch {
      statusEl.className = "status failed";
      statusEl.textContent = "read failed";
    }
  }
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
  renderBook();
  renderMyOrders();
  renderTape();
  if (state.role === "auditor") void renderAuditor();
}

function orderStatusChip(o: OrderRow, expired: boolean): string {
  if (o.stateCode === OrderState.PendingResolution) return statusChip("computing", "pending resolution");
  if (o.stateCode === OrderState.Cancelled) return statusChip("failed", "cancelled");
  if (expired) return statusChip("failed", "expired");
  return statusChip("confirmed", ORDER_STATE_LABEL[o.stateCode] ?? "open");
}

function renderBook() {
  const host = el("book");
  if (!host) return;

  if (!state.venue) {
    host.innerHTML = `<p class="empty">Loading the public book…</p>`;
    return;
  }
  const live = orders.filter((o) => o.stateCode !== OrderState.Cancelled);
  if (!live.length) {
    host.innerHTML = `<p class="empty">No orders yet. The book is empty — not hidden.</p>`;
    return;
  }

  const now = BigInt(Math.floor(Date.now() / 1000));

  host.innerHTML = [...live]
    .reverse()
    .map((o) => {
      const mine = o.maker.toLowerCase() === state.account.toLowerCase();
      const expired = o.expiry <= now;
      const pending = o.stateCode === OrderState.PendingResolution;

      const canFill = !mine && !expired && !pending && state.compliance.verified === true;

      return `
      <div class="row ${mine ? "mine" : ""}">
        <div class="row-main">
          <div class="row-title">
            <strong>#${o.id}</strong>
            ${orderStatusChip(o, expired)}
            ${mine ? `<span class="pill solid">yours</span>` : ""}
            <span class="lock"><svg><use href="#i-lock" /></svg><span>size &amp; price encrypted</span></span>
          </div>
          <div class="row-meta">
            <span>maker ${escapeHtml(shortAddr(o.maker))}</span>
            <span class="mono">qty ${escapeHtml(short(o.qtyRemaining))}</span>
            <span class="mono">px ${escapeHtml(short(o.price))}</span>
            <span>expires ${new Date(Number(o.expiry) * 1000).toLocaleTimeString()}</span>
          </div>
        </div>
        <div class="actions">
          ${
            mine
              ? ""
              : `<button class="small" data-fill="${o.id}" data-bucket="${Bucket.LargeInScale}" ${canFill ? "" : "disabled"}>Fill · LIS</button>
                 <button class="small" data-fill="${o.id}" data-bucket="${Bucket.Standard}" ${canFill ? "" : "disabled"}>Fill · standard</button>`
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
      return `
      <div class="row mine">
        <div class="row-main">
          <div class="row-title">
            <strong>#${o.id}</strong>
            ${orderStatusChip(o, o.expiry <= now)}
          </div>
          <div class="row-meta">
            <span class="mono">qty ${escapeHtml(short(o.qtyRemaining))}</span>
            <span class="mono">px ${escapeHtml(short(o.price))}</span>
          </div>
        </div>
        <div class="actions">
          ${pending ? `<button class="small" data-reopen="${o.id}">Reopen</button>` : ""}
          <button class="small" data-cancel="${o.id}" ${pending || cancelled ? "disabled" : ""}
            title="${pending ? "Blocked while a fill is unresolved" : "Reclaim the remainder"}">Cancel</button>
        </div>
      </div>`;
    })
    .join("");
}

/** The tape: compact prints, always docked, newest first. */
function renderTape() {
  const host = el("tape");
  if (!host) return;

  if (!fills.length) {
    host.innerHTML = `<p class="empty">No prints yet.</p>`;
    return;
  }

  const now = BigInt(Math.floor(Date.now() / 1000));

  host.innerHTML = [...fills]
    .reverse()
    .map((f) => {
      const lis = f.bucket === Bucket.LargeInScale;
      const passed = f.reported && now >= f.deferredUntil;
      const left = f.reported ? Number(f.deferredUntil - now) : 0;

      const price = f.pricePublic
        ? f.priceValue !== null
          ? `<div class="print-val pub">${fmt(f.priceValue)}</div>`
          : `<div class="print-val held">resolving…</div>`
        : `<div class="print-val held">withheld</div>`;

      let volume: string;
      if (f.volumePublic) {
        volume =
          f.volumeValue !== null
            ? `<div class="print-val pub">${fmt(f.volumeValue)}</div>`
            : `<div class="print-val held">resolving…</div>`;
      } else if (!f.reported) {
        volume = `<div class="print-val held">unreported</div>`;
      } else if (passed) {
        volume = `<div class="print-val count">ready</div>`;
      } else {
        volume = `<div class="print-val count" data-countdown="${f.deferredUntil}">${mmss(left)}</div>`;
      }

      return `
      <div class="print ${f.volumePublic ? "" : "gap-open"}">
        <div class="print-head">
          <span>fill #${f.id}</span>
          <span class="pill ${lis ? "warn" : "muted"}">${lis ? "LIS" : "standard"}</span>
        </div>
        <div class="print-legs">
          <div class="print-leg"><label>price</label>${price}</div>
          <div class="print-leg"><label>volume</label>${volume}</div>
        </div>
      </div>`;
    })
    .join("");
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
  await renderRegister();
  if (isAuditor) void fillAuditorValues();
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
                  ? `<div class="plain" id="audvol-${f.id}">decrypting…</div>`
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

async function fillAuditorValues() {
  for (const f of fills) {
    const node = document.getElementById(`audvol-${f.id}`);
    if (!node) continue;
    const v = await tryDecrypt(f.qty);
    const cur = document.getElementById(`audvol-${f.id}`);
    if (!cur) continue;
    if (v === null) {
      cur.textContent = "not yet resolved";
      cur.className = "cipher";
    } else {
      cur.textContent = fmt(v);
      cur.className = "plain";
      flashReveal(cur);
    }
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

  const amount = BigInt(($("depositAmount") as HTMLInputElement).value || "0");
  const leg = ($("depositLeg") as HTMLSelectElement).value as "cash" | "shares";
  if (amount <= 0n) {
    toast("error", "Amount must be positive");
    return;
  }

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

async function onPost(e: Event) {
  e.preventDefault();
  if (!requireReady()) return;

  const qty = BigInt(($("qty") as HTMLInputElement).value || "0");
  const price = BigInt(($("price") as HTMLInputElement).value || "0");
  const minutes = BigInt(($("expiry") as HTMLInputElement).value || "60");
  if (qty <= 0n || price <= 0n) {
    toast("error", "Quantity and price must both be positive");
    return;
  }

  const expiry = BigInt(Math.floor(Date.now() / 1000)) + minutes * 60n;

  await asyncAction(
    { button: document.querySelector<HTMLButtonElement>(`[data-async="post"]`), label: "Post ask", async: true, onSettled: refresh },
    async () => {
      const q = await encryptInput(qty, CONFIG.venue);
      const p = await encryptInput(price, CONFIG.venue);
      const tx = await state.venue!.postAsk(q.handle, p.handle, q.proof, p.proof, expiry);
      return tx.wait();
    },
  );
}

async function onFill(orderId: number, bucket: number, button: HTMLButtonElement) {
  if (!requireReady()) return;

  const bidRaw = window.prompt("Your bid price (scaled, e.g. 987500):");
  if (!bidRaw) return;
  const qtyRaw = window.prompt("Quantity you want:");
  if (!qtyRaw) return;

  await asyncAction(
    { button, label: `Fill #${orderId}`, async: true, onSettled: refresh },
    async () => {
      const bid = await encryptInput(BigInt(bidRaw), CONFIG.venue);
      const qty = await encryptInput(BigInt(qtyRaw), CONFIG.venue);
      const tx = await state.venue!.fill(orderId, bid.handle, qty.handle, bid.proof, qty.proof, bucket);
      return tx.wait();
    },
  );
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

  const fillBtn = t.closest?.("[data-fill]") as HTMLButtonElement | null;
  if (fillBtn) {
    void onFill(Number(fillBtn.dataset.fill), Number(fillBtn.dataset.bucket), fillBtn);
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

  const roleBtn = t.closest?.(".role") as HTMLButtonElement | null;
  if (roleBtn?.dataset.role) setRole(roleBtn.dataset.role as Role);
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

wireCopyButtons(document);

$("connect").addEventListener("click", () => connect().catch((e) => banner(e.message, "error")));
$("disconnect").addEventListener("click", () => disconnect().catch((e) => banner(e.message, "error")));
$("depositForm").addEventListener("submit", (e) => void onDeposit(e));
$("wrapForm").addEventListener("submit", (e) => void onWrap(e));
$("postForm").addEventListener("submit", (e) => void onPost(e));

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

setRole("trader");

if (!CONFIG.venue) {
  banner("No deployment configured — set VITE_VENUE and VITE_CHAIN_ID.", "info");
  render();
} else {
  render();
  void connectReadOnly().catch(() => {
    /* stays disconnected; Connect still works */
  });
}
