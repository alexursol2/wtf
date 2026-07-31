/**
 * Shared UI primitives.
 *
 * These exist so that every screen expresses the same three ideas the same way,
 * rather than each one inventing its own spinner and its own idea of what
 * "pending" means:
 *
 *   asyncAction  one lifecycle for every write — submitted, computing, settled
 *   lock         one encryption indicator, which unlatches when a value resolves
 *   copyable     one way to lift a handle or hash out of the page
 *
 * The status vocabulary is deliberately shared between transactions and
 * decryptions. Under TEE-async execution those are the same shape of problem:
 * you commit, and the answer arrives later.
 */

export type AsyncPhase = "idle" | "submitted" | "computing" | "confirmed" | "failed";

const PHASE_LABEL: Record<Exclude<AsyncPhase, "idle">, string> = {
  submitted: "submitted",
  computing: "computing",
  confirmed: "confirmed",
  failed: "failed",
};

/** Status chip markup, used for orders, balances and in-flight writes alike. */
export function statusChip(phase: Exclude<AsyncPhase, "idle">, text?: string): string {
  return `<span class="status ${phase}">${text ?? PHASE_LABEL[phase]}</span>`;
}

/**
 * A lock that opens.
 *
 * `open` is the whole point: the same element carries "this is encrypted" and
 * "you are now allowed to see it", so the transition is visible as a change of
 * state rather than as one element being swapped for another.
 */
export function setLock(el: HTMLElement | null, open: boolean, label?: string) {
  if (!el) return;
  el.classList.toggle("open", open);
  const text = el.querySelector("span");
  if (text) text.textContent = label ?? (open ? "decrypted" : "encrypted");
}

/** One-shot highlight when a value becomes readable for the first time. */
export function flashReveal(el: HTMLElement | null) {
  if (!el) return;
  el.classList.remove("revealed");
  void el.offsetWidth; // restart the animation
  el.classList.add("revealed");
}

/** Copy-to-clipboard control. Small thing; makes a demo look deliberate. */
export function copyable(value: string, label = "copy"): string {
  const safe = value.replace(/"/g, "&quot;");
  return `<button class="copy" data-copy="${safe}" title="Copy ${safe}" type="button">
    <svg><use href="#i-copy" /></svg>${label}
  </button>`;
}

/** Delegated handler — attach once, works for markup rendered later. */
export function wireCopyButtons(root: ParentNode = document) {
  root.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement)?.closest?.("[data-copy]") as HTMLButtonElement | null;
    if (!btn) return;
    const value = btn.dataset.copy ?? "";
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard permission can be refused; fall back to a selection so the
      // user can still copy manually rather than being told nothing happened.
      const ta = document.createElement("textarea");
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* nothing more we can do */
      }
      ta.remove();
    }
    const original = btn.innerHTML;
    btn.classList.add("done");
    btn.innerHTML = `<svg><use href="#i-copy" /></svg>copied`;
    setTimeout(() => {
      btn.classList.remove("done");
      btn.innerHTML = original;
    }, 1400);
  });
}

// ---------------------------------------------------------------------------
// toasts
// ---------------------------------------------------------------------------

export function toast(
  kind: "ok" | "error" | "info",
  title: string,
  detail?: string,
  ms = kind === "error" ? 9000 : 5200,
) {
  const host = document.getElementById("toasts");
  if (!host) return;

  const el = document.createElement("div");
  el.className = "toast";
  const phase = kind === "ok" ? "confirmed" : kind === "error" ? "failed" : "submitted";
  el.innerHTML = `
    ${statusChip(phase as any, "")}
    <div class="body">
      <div class="title">${escapeHtml(title)}</div>
      ${detail ? `<div class="detail">${escapeHtml(detail)}</div>` : ""}
    </div>`;
  host.appendChild(el);

  setTimeout(() => {
    el.style.transition = "opacity .3s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 320);
  }, ms);
}

// ---------------------------------------------------------------------------
// pre-signature review
// ---------------------------------------------------------------------------

export interface ReviewStep {
  /** "Fund escrow", "Buy 400 ACME30" — what this signature actually does. */
  label: string;
  /** One line on why it is needed, in the user's terms. */
  detail: string;
  /** Contract this step calls, so it can be matched against the wallet. */
  contract?: string;
}

/**
 * Shows what is about to be signed, and waits for a decision.
 *
 * This exists because a single click can produce more than one wallet prompt,
 * and the FIRST one is not the thing the user asked for. Placing an order tops
 * escrow up first, so pressing "Buy" opened a MetaMask dialog for a deposit —
 * a different contract call, reported by the wallet as "No changes" because the
 * amount it moves is encrypted and it cannot simulate it. From the user's side
 * that is indistinguishable from the site doing something it never mentioned.
 *
 * So every step is named up front, in order, with the contract address the
 * wallet will show. Nothing here can prevent a bad transaction — only the user
 * can — but it makes the wallet's dialog verifiable instead of surprising.
 */
export function reviewTransaction(opts: {
  title: string;
  steps: ReviewStep[];
  /** Shown above the steps when there is something to warn about. */
  note?: string;
  confirmLabel?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.getElementById("reviewModal");
    const body = document.getElementById("reviewBody");
    const titleEl = document.getElementById("reviewTitle");
    const okBtn = document.getElementById("reviewConfirm") as HTMLButtonElement | null;
    const noBtn = document.getElementById("reviewCancel");

    // No dialog in the DOM should never block a trade.
    if (!host || !body || !okBtn || !noBtn || !titleEl) {
      resolve(true);
      return;
    }

    titleEl.textContent = opts.title;

    const many = opts.steps.length > 1;
    body.innerHTML = `
      ${
        many
          ? `<p class="review-lead">This needs <strong>${opts.steps.length} separate wallet
             confirmations</strong>, in this order. Your wallet will ask once per step.</p>`
          : ""
      }
      ${opts.note ? `<p class="review-note">${escapeHtml(opts.note)}</p>` : ""}
      <ol class="review-steps">
        ${opts.steps
          .map(
            (s) => `
          <li>
            <div class="review-step-label">${escapeHtml(s.label)}</div>
            <div class="review-step-detail">${escapeHtml(s.detail)}</div>
            ${
              s.contract
                ? `<div class="review-step-contract mono">${escapeHtml(s.contract)}</div>`
                : ""
            }
          </li>`,
          )
          .join("")}
      </ol>
      <p class="review-foot">
        Amounts are encrypted before they leave this browser, so your wallet cannot preview them
        and will say <span class="mono">No changes</span>. That is expected here &mdash; check the
        contract address instead.
      </p>`;

    if (opts.confirmLabel) okBtn.textContent = opts.confirmLabel;

    const close = (answer: boolean) => {
      host.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      noBtn.removeEventListener("click", onNo);
      host.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(answer);
    };
    const onOk = () => close(true);
    const onNo = () => close(false);
    const onBackdrop = (e: Event) => {
      if (e.target === host) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
    };

    okBtn.addEventListener("click", onOk);
    noBtn.addEventListener("click", onNo);
    host.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);

    host.classList.remove("hidden");
    okBtn.focus();
  });
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// the async action
// ---------------------------------------------------------------------------

export interface AsyncActionOpts {
  /** Button that triggered it — disabled and relabelled through the lifecycle. */
  button?: HTMLButtonElement | null;
  /** Shown in toasts, e.g. "Post ask". */
  label: string;
  /**
   * Whether the result has to be computed off-chain before it means anything.
   * True for anything touching an encrypted value: the receipt is not the
   * answer, it is only the commitment.
   */
  async?: boolean;
  /** Called after settlement, successful or not. */
  onSettled?: () => void | Promise<void>;
}

/**
 * Runs a write through one lifecycle, so every screen behaves identically.
 *
 *   submitted  — sent, waiting for inclusion
 *   computing  — mined, but an encrypted result is still resolving off-chain
 *   confirmed  — done
 *   failed     — with the contract's own reason, which is always a plaintext
 *                gate; an encrypted shortfall never reverts
 */
export async function asyncAction<T>(
  opts: AsyncActionOpts,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const { button, label } = opts;
  const originalText = button?.textContent ?? "";

  const setPhase = (phase: Exclude<AsyncPhase, "idle">, text: string) => {
    if (!button) return;
    button.disabled = phase === "submitted" || phase === "computing";
    button.dataset.phase = phase;
    button.textContent = text;
  };

  setPhase("submitted", "Submitting…");
  toast("info", `${label} submitted`, "Waiting for inclusion.");

  try {
    const result = await fn();

    if (opts.async) {
      setPhase("computing", "Computing…");
      toast(
        "ok",
        `${label} confirmed on-chain`,
        "The encrypted result is still resolving in the TEE — values may lag by a few seconds.",
      );
    } else {
      toast("ok", `${label} confirmed`);
    }

    setPhase("confirmed", "Done");
    setTimeout(() => {
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
        delete button.dataset.phase;
      }
    }, 1500);

    return result;
  } catch (err: any) {
    const reason =
      err?.reason ??
      err?.info?.error?.message ??
      err?.shortMessage ??
      err?.message ??
      "transaction failed";
    setPhase("failed", "Failed");
    toast("error", `${label} failed`, String(reason).slice(0, 220));
    setTimeout(() => {
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
        delete button.dataset.phase;
      }
    }, 1800);
    return undefined;
  } finally {
    await opts.onSettled?.();
  }
}
