/**
 * Portal tooltips.
 *
 * The previous implementation was a CSS `::after` on the trigger itself. That
 * is structurally incapable of escaping its container: a tooltip on the ticker
 * label lived inside `.ticker-track { overflow: hidden }` and was clipped, and
 * one near the right edge of the viewport was cut off by the window. Widening
 * the parents is not a fix — it just moves the clipping somewhere else, and it
 * cost us a document-wide horizontal scrollbar the first time round.
 *
 * So the tooltip is not a child of the trigger at all. One node lives at the
 * end of `document.body` — outside every scroll and clip container — and is
 * positioned with `position: fixed` against the trigger's viewport rect, then
 * flipped and clamped so it can never leave the screen. This is the same
 * approach Radix/floating-ui take; it needs no framework, only the rect.
 *
 * Usage stays declarative and unchanged at the call site: put `data-tip` on any
 * element, including markup rendered later, and it works.
 */

const GAP = 8; // space between trigger and tooltip
const EDGE = 8; // minimum distance from any viewport edge

let node: HTMLDivElement | null = null;
let current: HTMLElement | null = null;

function ensureNode(): HTMLDivElement {
  if (node) return node;
  node = document.createElement("div");
  // Deliberately not `.tip`: that class already named an unrelated inline badge
  // component, and sharing it meant the badge's `position: relative` won on
  // source order and dropped the portal to the bottom of the document.
  node.className = "tooltip-portal";
  node.setAttribute("role", "tooltip");
  node.hidden = true;
  document.body.appendChild(node);
  return node;
}

/**
 * Places the tooltip against the trigger.
 *
 * Preference is below; it flips above when there is no room, and the
 * horizontal position is clamped into the viewport rather than allowed to
 * overflow. Measuring happens while the node is visible but off-screen, so the
 * width used for clamping is the real one.
 */
function place(tip: HTMLElement, trigger: HTMLElement) {
  const r = trigger.getBoundingClientRect();

  tip.style.left = "0px";
  tip.style.top = "0px";
  tip.hidden = false;

  const t = tip.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  // Vertical: below by default, above when it would overflow the bottom and
  // there is more room on top.
  const below = r.bottom + GAP;
  const above = r.top - GAP - t.height;
  const flip = below + t.height > vh - EDGE && above >= EDGE;
  const top = flip ? above : below;

  // Horizontal: align to the trigger's left edge, then clamp both sides.
  let left = r.left;
  if (left + t.width > vw - EDGE) left = vw - EDGE - t.width;
  if (left < EDGE) left = EDGE;

  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(Math.max(EDGE, Math.min(top, vh - EDGE - t.height)))}px`;
  tip.dataset.flip = String(flip);
}

function show(trigger: HTMLElement) {
  const text = trigger.dataset.tip;
  if (!text) return;
  const tip = ensureNode();
  current = trigger;
  tip.textContent = text;
  place(tip, trigger);
  tip.classList.add("open");
}

function hide() {
  current = null;
  if (!node) return;
  node.classList.remove("open");
  node.hidden = true;
}

/**
 * Attach once. Delegated, so anything rendered later picks it up for free —
 * which matters here because the book, the tape and the auditor rows are all
 * rebuilt from innerHTML on every refresh.
 */
export function initTooltips() {
  const triggerFor = (e: Event): HTMLElement | null =>
    ((e.target as HTMLElement)?.closest?.("[data-tip]") as HTMLElement) ?? null;

  document.addEventListener(
    "pointerover",
    (e) => {
      const t = triggerFor(e);
      if (t && t !== current) show(t);
    },
    true,
  );

  document.addEventListener(
    "pointerout",
    (e) => {
      const t = triggerFor(e);
      // Ignore moves *within* the same trigger; only leaving it should close.
      if (t && t === current && !t.contains((e as PointerEvent).relatedTarget as Node)) hide();
    },
    true,
  );

  // Keyboard parity: the tooltip is content, so it must be reachable without a
  // pointer. focusin/out mirror the hover pair.
  document.addEventListener("focusin", (e) => {
    const t = triggerFor(e);
    if (t) show(t);
  });
  document.addEventListener("focusout", () => hide());

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });

  // A tooltip anchored to a rect is stale the moment anything moves it. Rather
  // than track, just close — reopening is one hover away.
  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
}
