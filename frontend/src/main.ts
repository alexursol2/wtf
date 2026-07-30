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
import { BrowserProvider, Contract, JsonRpcSigner, ZeroHash } from "ethers";
import {
  createEthersHandleClient,
  NotYetComputedHandleError,
  UnknownHandleError,
  type HandleClient,
} from "@iexec-nox/handle";
import { VENUE_ABI, NOX_ABI } from "./abi.js";
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
  priceScale: 10000n,
  lisDeferral: 90n,
  auditor: "",
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
async function getHandleClient(): Promise<HandleClient> {
  if (!state.signer) throw new Error("connect a wallet first");
  if (state.handleClient) return state.handleClient;

  const override: Record<string, string> = {};
  const gatewayUrl = (import.meta.env as any).VITE_NOX_GATEWAY_URL;
  const subgraphUrl = (import.meta.env as any).VITE_NOX_SUBGRAPH_URL;
  if (gatewayUrl) override.gatewayUrl = gatewayUrl;
  if (subgraphUrl) override.subgraphUrl = subgraphUrl;

  state.handleClient = await createEthersHandleClient(
    state.signer as any,
    Object.keys(override).length > 0 ? (override as any) : undefined,
  );
  return state.handleClient;
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
    if (e instanceof NotYetComputedHandleError || e instanceof UnknownHandleError) return null;
    if (/not yet computed|unknown handle/i.test(e?.message ?? "")) return null;
    throw e;
  }
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

  $("netLabel").textContent = `${CHAIN_NAMES[state.chainId] ?? state.chainId} · ${shortAddr(state.account)}`;
  $("netLabel").className = "pill ok";
  $("connect").textContent = "Connected";

  try {
    state.priceScale = await state.venue.PRICE_SCALE();
    state.lisDeferral = await state.venue.LIS_DEFERRAL();
    state.auditor = await state.venue.auditor();
    $("priceScale").textContent = state.priceScale.toString();
  } catch {
    banner("Could not read the venue — is VITE_VENUE correct for this chain?", "error");
    return;
  }

  clearBanner();
  await refresh();
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
        pricePublic: await isPublic(f.price),
        volumePublic: await isPublic(f.qty),
      });
    } catch {
      /* skip */
    }
  }

  orders = nextOrders;
  fills = nextFills;

  await refreshOwnPosition();
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
  if (!state.venue || !state.nox) return;

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

  el.innerHTML = fills
    .map((f) => {
      const isMaker = f.maker.toLowerCase() === state.account.toLowerCase();
      const lis = f.bucket === Bucket.LargeInScale;
      const deferralPassed = f.reported && now >= f.deferredUntil;

      const price = f.pricePublic
        ? `<span class="pill pub">price published</span>`
        : `<span class="pill muted">price private</span>`;
      const volume = f.volumePublic
        ? `<span class="pill pub">volume published</span>`
        : f.reported
          ? `<span class="pill warn">volume deferred${
              deferralPassed ? " — publishable now" : ` until ${new Date(Number(f.deferredUntil) * 1000).toLocaleTimeString()}`
            }</span>`
          : `<span class="pill muted">unreported</span>`;

      // Reporting is the maker's act — they are the reporting entity. An
      // unreported fill is visible to the auditor but not preventable here.
      const actions: string[] = [];
      if (isMaker && !f.reported) actions.push(`<button data-report="${f.id}">Report trade</button>`);
      if (f.reported && !f.volumePublished)
        actions.push(
          `<button data-publish="${f.id}" ${deferralPassed ? "" : "disabled"}>Publish volume</button>`,
        );

      return `
        <div class="row">
          <div class="row-main">
            <div class="row-title">
              <strong>fill #${f.id}</strong>
              <span class="pill ${lis ? "" : "muted"}">${lis ? "large in scale" : "standard"}</span>
              ${price}${volume}
            </div>
            <div class="row-meta">
              <span>maker ${shortAddr(f.maker)}</span>
              <span>taker ${shortAddr(f.taker)}</span>
              <span>price <code class="handle">${short(f.price)}</code></span>
              <span>qty <code class="handle">${short(f.qty)}</code></span>
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

$("connect").addEventListener("click", () => connect().catch((e) => banner(e.message, "error")));
$("postForm").addEventListener("submit", (e) => onPost(e).catch((e) => banner(e.message, "error")));

// Keep deferral countdowns and "publishable now" states honest without a reload.
setInterval(() => {
  if (state.venue) render();
}, 15_000);

if (!CONFIG.venue) {
  banner(
    "No deployment configured. Run the deploy scripts, then set VITE_VENUE (and VITE_CHAIN_ID) — " +
      "addresses are written to deployments/venue.*.json.",
    "info",
  );
}

render();
