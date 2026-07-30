/**
 * Chain of Trust — what is actually verifiable today, checked live.
 *
 * iExec's attestation story asks three questions: did the right code run, did it
 * run on the right hardware, and was that hardware in a verified environment?
 * This script establishes which of them a venue built on the hosted Nox stack
 * can answer for itself, by calling the real public API rather than describing
 * it.
 *
 * FINDING (30 July 2026, verified by probing, not by reading docs):
 *
 *   trust.noxprotocol.io exposes exactly ONE API route: POST /api/attestation.
 *   Every other path — /quote, /attestation, /health — returns the SPA's HTML,
 *   and /api/{deployments,apps,instances,quote,info,verify,...} all 404.
 *
 *   That route takes { digest, attestationRepo, signingRepo } and answers a
 *   BUILD PROVENANCE question: was this container image digest produced by that
 *   source repository, per its GitHub build attestation? It is supply-chain
 *   verification. It is not per-execution attestation, and it has no notion of
 *   a fill.
 *
 *   The primitive that per-fill attestation would need does exist:
 *   dstack-quote-service exposes GET /quote?data=<custom>, which binds
 *   arbitrary custom data into a TDX quote and replays the RTMRs, plus GET
 *   /info for app id, instance id, measurements and compose hash. Binding a
 *   fill id or a request hash there is exactly the right shape.
 *
 *   But it is a SIDECAR: it listens on 0.0.0.0:9999 INSIDE the CVM, next to
 *   nox-runner. Only whoever operates that runner can call it. On the hosted
 *   testnet stack we do not, and no public endpoint proxies it. So a venue
 *   cannot retrieve a quote bound to its own fill.
 *
 * CONCLUSION: per-fill attestation is designed, not shipped. See the README.
 * We do not add an `attestationRef` to the Fill struct, because we could not
 * populate it, and a field that is always empty is worse than an honest gap.
 *
 *   npx hardhat run scripts/attestation-check.ts
 *   DIGEST=sha256:… ATTESTATION_REPO=owner/repo SIGNING_REPO=owner/repo npx hardhat run scripts/attestation-check.ts
 */

const TRUST_API = "https://trust.noxprotocol.io/api/attestation";
const QUOTE_SERVICE_REPO = "https://github.com/iExec-Nox/dstack-quote-service";

interface Probe {
  label: string;
  detail: string;
  ok: boolean | null;
}

async function main() {
  const results: Probe[] = [];

  console.log(`\n=== Chain of Trust: what a venue can verify today ===\n`);

  // ---- 1. is the public attestation service reachable at all? -----------
  let live = false;
  try {
    const res = await fetch(TRUST_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => ({}));
    live = res.status === 400 || res.status === 200;
    results.push({
      label: "trust.noxprotocol.io/api/attestation reachable",
      detail: `HTTP ${res.status} — ${(body as any).error ?? JSON.stringify(body).slice(0, 90)}`,
      ok: live,
    });
  } catch (e: any) {
    results.push({
      label: "trust.noxprotocol.io/api/attestation reachable",
      detail: e.message,
      ok: false,
    });
  }

  // ---- 2. verify a real digest, if one was supplied ---------------------
  const digest = process.env.DIGEST;
  const attestationRepo = process.env.ATTESTATION_REPO ?? "iExec-Nox/dstack-quote-service";
  const signingRepo = process.env.SIGNING_REPO ?? attestationRepo;

  if (digest) {
    try {
      const res = await fetch(TRUST_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ digest, attestationRepo, signingRepo }),
        signal: AbortSignal.timeout(30_000),
      });
      const body: any = await res.json();
      results.push({
        label: `build provenance for ${digest.slice(0, 24)}…`,
        detail: `verified=${body.verified} ${body.reason ? `reason=${body.reason}` : ""} ${body.error ?? ""}`.trim(),
        ok: body.verified === true,
      });
    } catch (e: any) {
      results.push({ label: "build provenance check", detail: e.message, ok: false });
    }
  } else {
    results.push({
      label: "build provenance check",
      detail: "skipped — set DIGEST=sha256:… to verify a specific image",
      ok: null,
    });
  }

  // ---- 3. is a per-fill quote reachable? --------------------------------
  // The sidecar binds to 0.0.0.0:9999 inside the CVM. There is no public host
  // to try, which is itself the finding — record it rather than pretending to
  // probe something that cannot exist.
  results.push({
    label: "per-fill TDX quote retrievable by the venue",
    detail: "no — the quote sidecar is CVM-internal (:9999), callable only by the runner operator",
    ok: false,
  });

  // ---- report ------------------------------------------------------------
  const width = Math.max(...results.map((r) => r.label.length));
  for (const r of results) {
    const mark = r.ok === null ? "–" : r.ok ? "yes" : "no ";
    console.log(`  [${mark}] ${r.label.padEnd(width)}  ${r.detail}`);
  }

  console.log(`\n--- what this means ---\n`);
  console.log(`  VERIFIABLE today: build provenance. Given an image digest and its source`);
  console.log(`  repo, the public API confirms the image was built from that source, using`);
  console.log(`  GitHub build attestations. That answers "did the right code get built".`);
  console.log(``);
  console.log(`  NOT VERIFIABLE by us: that a SPECIFIC fill was executed by that code in a`);
  console.log(`  verified TDX environment. The primitive exists — ${QUOTE_SERVICE_REPO}`);
  console.log(`  exposes GET /quote?data=<custom>, which binds arbitrary data into a quote`);
  console.log(`  and replays RTMRs, and GET /info for measurements and compose hash. Binding`);
  console.log(`  a fill id there is exactly the right design.`);
  console.log(``);
  console.log(`  The obstacle is topological, not cryptographic: that sidecar runs INSIDE`);
  console.log(`  the CVM alongside nox-runner and is reachable only by whoever operates it.`);
  console.log(`  On the hosted testnet stack, that is not us.`);
  console.log(``);
  console.log(`  So: designed, not shipped. The Fill struct carries no attestationRef,`);
  console.log(`  because we could not populate it, and an always-empty field would be a`);
  console.log(`  worse lie than an acknowledged gap.\n`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});
