# Deferral Venue

**A trading venue that publishes on a schedule: price at settlement, volume when the deferral elapses, and the regulator ahead of both.**

That schedule is the product. An RFQ venue for tokenized bonds, with post-trade disclosure modelled on the MiFIR transparency regime — dark pre-trade under a large-in-scale waiver, then printing in the order and at the times the regime prescribes.

We did not add a privacy feature to a trading venue. We implemented **both halves of a transparency regime** as a smart contract. Hiding data is the easy half; deciding *when it stops being hidden, and to whom* is the half that makes it a venue.

That is what **programmable privacy** buys here. Not concealment, but a disclosure schedule enforced by the protocol rather than by a policy document: **selective disclosure** to the regulator at the moment of the fill, **auditability on demand** for the holder register, and public prints on the deferral clock. And because the ERC-3643 token is wrapped rather than forked, it is **privacy without breaking composability** — the underlying asset stays exactly what it was.

> Throughout this repository the phrasing is **"modelled on the MiFIR regime"**, never "compliant with". Thresholds are recalibrated per instrument annually and none of this has been near a lawyer.

---

## What is actually differentiated

**1. No operator in the matching decision.** The nearest prior art routes matching through a gateway callback: an off-chain actor evaluates the encrypted comparison and calls back to finalise the fill. That actor learns whether the order crossed. Branchless `select` puts **nobody** in that position — not the venue operator, not iExec, not the TEE Runner. Operator orderflow visibility is named in dark-pool research as the thing that reintroduces the exact asymmetry dark pools exist to remove.

**2. T-REX is unmodified.** Other confidential ERC-3643 projects fork the token. We wrap it. That is technically weaker — hence the pooling limitation named below — but it is literally the brief: privacy without breaking composability, added on top of the underlying protocol rather than carved into it. A forked token is a new asset; a wrapped one is still the bond.

**None of the ingredients are novel.** Confidential ERC-3643, the ERC-20→confidential wrapper, the three-layer stack, and encrypted RFQ with post-trade reveal all exist already. The assembly is ours; "novel combination" is a weak claim and we do not lean on it.

---

## Architecture

Three layers. The first two are separate Hardhat projects because they **cannot coexist** — T-REX is Hardhat 2 / solc 0.8.17, the Nox side is Hardhat 3 / solc 0.8.35.

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 3 — DeferralVenue          RFQ venue, branchless fill │
│           reportTrade / publishVolume — the disclosure regime│
├─────────────────────────────────────────────────────────────┤
│ Layer 2 — ConfidentialWrapper    ERC-7984-style, encrypted   │
│           balances. Deployed TWICE: bond leg and cash leg.   │
├─────────────────────────────────────────────────────────────┤
│ Layer 1 — T-REX (ERC-3643) v4.1.6, UNMODIFIED                │
│           Token · IdentityRegistry · ModularCompliance       │
│           CountryRestrictModule · SupplyLimitModule          │
└─────────────────────────────────────────────────────────────┘
```

| Path | Contents |
|---|---|
| `trex/` | Layer 1. Hardhat 2, solc 0.8.17. Deploy script for the full ERC-3643 suite. |
| `nox/` | Layers 2 and 3, tests, deploy and demo scripts. Hardhat 3, solc 0.8.35, `viaIR`. |
| `frontend/` | Vite + TypeScript UI: book, tape, escrow, optimistic pending states. |
| `deployments/` | Addresses written by the deploy scripts. |

**Both legs are confidential.** The same wrapper is deployed for the bond and for a mock stablecoin. A public payment leg would leak the price and void the entire design.

---

## Why the code looks unusual

Nox is **TEE-async, not synchronous FHE**. Every `Nox.*` operation emits an event, returns a *handle*, and completes the transaction with **no value computed**. An off-chain Ingestor picks up the event; a Runner decrypts inside Intel TDX, computes, re-encrypts, and stores.

**An encrypted value can never be read on-chain — not in this transaction, not in any later one.** Three consequences drive the whole design:

**No branching on encrypted values.** `Nox.ge(bid, price)` returns an `ebool` the contract can never read. There is no `if`, no `require`, no revert on it. Settlement is branchless. This is also the *correct* privacy behaviour: a contract that reverts on insufficient balance tells every observer the balance was insufficient.

**Conjunction is impossible at the boolean level.** Nox has no boolean operators, `select` has no `ebool` overload, and there is no `ebool → euint` cast. You cannot AND two `ebool`s. So the **quantity** is gated through nested selects and zero propagates downstream:

```solidity
euint256 qtyGated = Nox.select(crosses, Nox.select(noOverflow, fillQty, ZERO), ZERO);
```

**Every operation mints new handles, and every new handle needs a fresh persistent ACL grant.** `Nox.transfer` returns three. Miss one grant and the handle goes dead *silently* — the frontend shows an empty balance and it looks exactly like async lag. This is the single most likely bug in a Nox project, which is why the test suite asserts grants directly against on-chain ACL state.

---

## Disclosure is a separate act

`fill()` **publishes nothing.** This is a security property, not an oversight.

Because `crosses` is an unreadable `ebool`, an `allowPublicDecryption(price)` placed inside `fill()` would execute **unconditionally**. An attacker fills every open order with an encrypted bid of `1`: every quantity collapses to zero, no money moves, no trade occurs — **and every maker's price becomes publicly decryptable.** One block, the whole book, and it is **permanent**, because nothing in the Nox ACL surface can un-publish a handle.

Instead:

- **`reportTrade(fillId)`** is maker-only and publishes the price. The maker is the reporting entity, as in the real regime.
- **`publishVolume(fillId)`** publishes the volume once the deferral has elapsed.

This is *more* faithful to the regulation than automatic disclosure: post-trade transparency is an obligation on the reporting party to publish, not an automatic property of matching. Failing to report is a breach **visible to the regulator from the first block** — the auditor holds the quantity handle — but not preventable by the contract. Exactly like real life.

The fill price is a **snapshot handle** (`Nox.add(o.price, ZERO)`), never the live order's, because publication is permanent and the order may still be resting.

`Bucket` is **plaintext**. It cannot be derived on-chain from an encrypted quantity. This mirrors MiFIR, where the deferral flag is itself public. Mis-declaration is **detectable by the auditor, not preventable by the contract**.

---

## Chain of Trust — what we can and cannot attest

iExec's attestation work asks three questions: did the right code run, did it run on the right hardware, and was that hardware in a verified environment? The strong version of the claim for a venue would be: *the regulator does not merely receive the numbers, they receive evidence the venue executed the code it claims.* We cannot make that claim honestly today, and this section says exactly why.

```bash
npx hardhat run scripts/attestation-check.ts
```

**Verifiable today — build provenance.** `trust.noxprotocol.io` exposes exactly one API route, `POST /api/attestation`, taking `{digest, attestationRepo, signingRepo}`. It confirms that a container image digest was produced by a given source repository, via GitHub build attestations. That answers *did the right code get built*. Every other path on that host returns the SPA's HTML, and the obvious `/api/*` alternatives all 404 — checked by probing, not by reading docs.

**Not verifiable by us — that a specific fill ran in a verified TEE.** The primitive genuinely exists: [`dstack-quote-service`](https://github.com/iExec-Nox/dstack-quote-service) exposes `GET /quote?data=<custom>`, which binds arbitrary custom data into a TDX quote and replays the RTMRs, plus `GET /info` for app id, instance id, measurements and compose hash. Binding a fill id or a request hash into that `data` field is exactly the right shape for per-fill attestation.

The obstacle is topological rather than cryptographic. That service is a **sidecar**: it listens on `0.0.0.0:9999` *inside* the CVM, next to `nox-runner`, and is reachable only by whoever operates the runner. On the hosted testnet stack that is not us, and no public endpoint proxies it.

**So per-fill attestation is designed, not shipped.** The design is concrete — add an `attestationRef` to `Fill`, have the runner bind the fill id into the quote's custom data, and surface the quote, RTMRs and compose hash per trade. We did not add the field, because we could not populate it, and a struct member that is always empty is a worse misrepresentation than an acknowledged gap.

## Disclosure matrix

Selective disclosure, party by party. Note the two different mechanisms: fill volumes reach the regulator **automatically** at the moment of the fill, while the holder register is **auditability on demand** — sealed until the issuer discloses a named holder. The venue operator row is the one worth arguing about.

| Party | Sees |
|---|---|
| Investor | own balance, own orders, own fills |
| Issuer | full holder register (encrypted layer) |
| Auditor — fill volumes | granted **automatically** at fill, before the public deferral elapses |
| Auditor — holder register | granted **on request** by the issuer |
| Counterparty | only their own trade |
| **Venue operator** | **nothing beyond public** — no match visibility, by construction |
| Public — at settlement | execution price, deferral flag |
| Public — after deferral | volume |

---

## Leak model

**What we hide:** order quantities, pre-trade prices, balances, holder allocations, remaining order depth, and volume until the deferral elapses.

**What we do NOT hide:**

- that an address posted or filled an order — events are public
- order timing and expiry — plaintext
- counterparty pairs
- executed price — deliberately published at settlement
- **the deferral flag** — declaring a fill large-in-scale announces it was large. Mirrors MiFIR, where the flag is public by design.
- **number of fills against an order** — one event per fill, so fill *count* leaks even though fill *size* does not
- **wrap and unwrap amounts** — they ride a plaintext ERC-20 transfer at the custody boundary. Confidentiality applies to balances and transfers *between* wrapped holders.
- **amount-gated compliance rules are not enforced on the encrypted path** (see below)
- **access grants are permanent** — Nox has no revocation primitive, so an auditor granted a handle holds it forever, and a published price or volume can never be un-published
- **unreported trades** — a maker who never calls `reportTrade` leaves the print missing. Visible to the auditor, not preventable by the contract.
- **partial fills reveal the resting order's price level.** The print value equals the order value, so reporting a fill tells the market where the remainder sits. Inherent to trade prints in any market. The price snapshot keeps the live *handle* private but cannot hide the value.
- **with few participants, timing + counterparty + price is a meaningful correlation surface.** A five-trader pool is not anonymous.

---

## Honest limitations

**The pooling problem.** Custody means T-REX sees **one holder of record** holding everything. Max-holder caps, country restrictions and per-investor limits are evaluated against a single aggregate address. Compliance has been *pooled around*, not preserved.

*Mitigation:* the wrapper re-enforces `IdentityRegistry.isVerified` plus the country rule on every path that credits a confidential balance — wrap, confidential transfer, and unwrap.

This is demonstrable rather than asserted:

```bash
npx hardhat run scripts/compliance-demo.ts --network sepolia
```

It shows the pooled balance at Layer 1, then a confidential transfer to a restricted country failing with revert reason `"country"` — on a transfer whose amount is a ciphertext handle — and the same path succeeding to an allowed country, so the rejection is the rule working rather than the path being broken. Reverting on identity and country leaks nothing, because both are plaintext facts; the amount never is.

**Amount-gated rules are not enforced on the encrypted path.**

> We re-enforce **identity and country** rules inside the confidential layer. **Amount-gated rules — max balance, max transfer size, supply limits — are not enforced on the encrypted path.** Enforcing them would require a readable comparison against an encrypted balance, which the architecture deliberately makes impossible. A branchless `select(withinCap, amount, ZERO)` would restore them at the cost of settling violations to zero rather than reverting; we did not ship it. Documented limitation, not an oversight.

We do **not** call `compliance.canTransfer(from, to, 0)` and describe it as enforcement. A zero amount passes every amount-gated module trivially.

**Venue escrow is not backed by the wrapper.** `depositShares` and `depositCash` credit a self-declared encrypted amount and never call the `ConfidentialWrapper`; the venue does not reference it on any path. So escrow is unbacked — a verified participant can credit themselves an arbitrary encrypted balance.

The architecture intended the wrapper to be touched on deposit and withdraw, with only `fill()` kept off it to avoid cross-contract ACL propagation on the hot path. We built the hot path and the wrapper, and did not wire the deposit path between them.

What this does and does not affect: settlement *between* parties is still exact — the branchless fill moves real encrypted balances and the arithmetic is verified on-chain. What is missing is the link tying escrow to actual custody, which in production would make `depositShares` pull via `confidentialTransfer` from the wrapper. Naming it is the honest position; it is a missing integration, not a broken one.

**Grants are permanent.** There is no revocation primitive. The honest mitigation is revocation-by-rotation — move the value into a fresh handle and grant only the parties who should still see it. The historical handle stays readable for its historical value. **We do not claim this as a tested feature.**

**An order can never be known to be exhausted.** `qtyRemaining` is encrypted, so there is no on-chain "fully filled" state. The maker decrypts their own remainder and cancels to reclaim. This is a genuine consequence of confidentiality, not an unfinished feature.

**The book is two-sided.** `postAsk` rests shares, `postBid` rests cash, `fill` lifts an ask and `hit` sells into a bid. Both taker paths are branchless and gate on the same crossing test, mirrored:

| UI action | Contract call | Notes |
|---|---|---|
| Limit sell (crossing) | `hit` | Executes against a resting bid |
| Limit sell (resting) | `postAsk` | You become the maker and the reporting entity |
| Limit buy (crossing) | `fill` | `Nox.ge(bid, price)` gates it; a non-crossing bid settles to **zero**, never reverts |
| Limit buy (resting) | `postBid` | Escrows `qty × price ÷ 1e4` in cash |
| Market buy | `fill` with a crossing bid | Debited `qty × ask ÷ 1e4`, never your bid, so bidding high does not overpay |
| Market sell | `hit` with a minimal ask | Any resting bid clears it |

In `hit` the shares leg moves **first**, and its success flag gates the cash release. Paying first and checking delivery afterwards would let an empty seller drain a bid's escrow, and no revert could undo it — the shortfall is a ciphertext nothing on-chain can read.

The **reporting entity is always the order's maker**, on both paths: who quoted the price decides the disclosure obligation, not who happened to lift it.

**Partial-fill percentages are only shown where both numbers are real.** `qtyRemaining` shrinks as fills land, but the original size is never stored on-chain and `Fill` does not carry its order id, so `filled/original` cannot be reconstructed from contract state. The frontend records the quantity *you typed* when posting (your own plaintext, in `localStorage`) and draws a bar only when it also holds a viewer grant on the remainder. An order posted from another browser shows "size sealed" rather than a fabricated ratio.

**Circuit breakers are live.** `setPaused` / `setFillFrozen` are auditor-only and covered by tests. Both act on plaintext state deliberately: gating settlement on an encrypted flag would silently zero trades rather than stopping them. Pausing halts *new* orders and fills — it cannot reverse a settled trade, because settlement has already moved encrypted balances and there is no un-transfer. Freezing a fill therefore blocks its **disclosure**, not its economics.

**Escrow now has a withdrawal.** `withdrawCash` / `withdrawShares` are the counterpart to the deposits; previously value could enter escrow and only leave by being traded away. Over-withdrawing moves zero rather than reverting, for the usual reason — a revert would confirm the size of a balance the venue cannot otherwise disclose. *The UI does not call these yet;* its Withdraw button drives the wrapper's unwrap.

> **Picking this up on another machine?** `CONTINUE.md` has the full setup, the env vars that are not in git, the redeploy/re-seed runbook, and the traps worth knowing before you touch anything.

**All three instruments are real, and each has its own book.** `ACME30`, `AAPL.rwa` and `TSLA.rwa` each have a deployed ERC-3643 token and a `ConfidentialWrapper` on Sepolia, sharing the one `IdentityRegistry` — so an address verified for one is verified for all three.

| # | Instrument | Token | Wrapper |
|---|---|---|---|
| 0 | ACME30 | `0xb0ba5244…f94E7` | `0x28bf0728…b4dd8` |
| 1 | AAPL.rwa | `0xDd2B5764…9BAf53` | `0xd673ad27…4826cc` |
| 2 | TSLA.rwa | `0x275E645a…62d982` | `0x758c57f1…844a9b` |

`Order` and `Fill` carry a plaintext `uint8 instrument` — an index into that table. Plaintext on purpose: *which* security is quoted is not the secret, the size and the price are, and an encrypted tag could never be compared. **The index order is load-bearing**; appending is safe, reordering silently re-labels every existing order.

Each instrument gets its own `ModularCompliance` because `bindToken` binds one-to-one; the identity layer is deliberately *not* duplicated, since a second `IdentityRegistry` would leave every already-verified address unverified against it and the venue points at exactly one.

**Escrow funding is automatic, not wallet-direct.** The manual deposit card is gone: placing an order tops escrow up inline, sized to the order with the buffer applied. It cannot be a true wallet-direct swap. `postAsk` and `fill` move value out of `escrowShares` / `escrowCash` and the venue has no path that touches a wallet — and escrow is *where the encrypted balance lives*, so pulling an exact amount per trade would publish the trade size on-chain and end the confidentiality the venue exists to provide.

---

## Price convention

```
notional = qty × price / PRICE_SCALE        PRICE_SCALE = 1e4
```

Bonds quote as `98.7500` → `987500`. Without this the tape prints a meaningless number.

---

## Running it

Requires **Node ≥ 22** (Node 24 used here). Docker is required only for iExec's official local Nox stack; the test suite in this repo does not need it (see *Testing*).

```bash
git clone <this repo> && cd venue
```

### Layer 1 — T-REX

```bash
cd trex && npm install --legacy-peer-deps && npx hardhat compile
```

Deploy. It comes up with **zero claim topics** first, because `isVerified` returns `true` immediately when no topics are required — get the pipeline green before adding complexity:

```bash
npx hardhat run scripts/deploy-trex.ts
```

Second pass, with a claim issuer and a registered topic:

```bash
WITH_CLAIMS=true npx hardhat run scripts/deploy-trex.ts
```

Addresses land in `deployments/trex.<network>.json`.

### Layers 2 and 3 — the venue

```bash
cd ../nox && npm install && npx hardhat compile
```

Check your accounts and the off-chain stack before spending gas:

```bash
npx hardhat run scripts/check-accounts.ts --network sepolia
```

That reports balances per role, whether NoxCompute is deployed on the target
chain, and whether the gateway and subgraph respond. Only the deployer and taker
need ETH; **the auditor needs none** — it sends no transactions, because
decryption is an off-chain signed request. Top the others up from the deployer
with `scripts/fund-accounts.ts`.

`viaIR` is on. `fill()` does not compile without it — stack too deep. Compilation is noticeably slower; this is expected.

```bash
npm test          # 32 tests
npm run demo      # one full trade, narrated
```

Against a live deployment:

```bash
npx hardhat run scripts/task0-liveness.ts --network sepolia   # is the off-chain stack up?
npx hardhat run scripts/live-trade.ts     --network sepolia   # one real trade, every value checked
FILL_ID=0 npx hardhat run scripts/publish-volume.ts --network sepolia
```

`live-trade.ts` is the script that matters: it settles a real trade and asserts every decrypted number, including that the fill settles at the **maker's** price rather than the taker's bid. Its expectations are deltas on the opening balances, so it is safe to re-run.

Deploy against a live Layer 1:

```bash
IDENTITY_REGISTRY=0x… BOND_TOKEN=0x… npx hardhat run scripts/deploy.ts --network sepolia
```

The deploy script refuses any chain without a NoxCompute deployment rather than failing later at the first encrypted operation. `AUDITOR` is optional — it defaults to the address derived from `PRIVATE_KEY_AUDITOR`.

### Feeding the wrappers back into Layer 1

There is an unavoidable ordering loop. Each wrapper takes **custody** of the T-REX token, so it must be a verified holder of record — but a wrapper's address does not exist until Layer 2 is deployed, which happens after Layer 1. So register them afterwards, once per wrapper:

```bash
HOLDER=0x<wrapper> COUNTRY=250 npx hardhat run scripts/register-holder.ts --network sepolia
```

Registering a *contract* as a holder is routine, not a trick: `isVerified` checks for a registered identity plus claims and does not distinguish an EOA from a contract.

Full order: T-REX deploy → note `IDENTITY_REGISTRY` and `BOND_TOKEN` → Nox deploy → register both wrappers → first trade.

### Frontend

```bash
cd ../frontend && npm install
VITE_VENUE=0x… VITE_CHAIN_ID=11155111 npm run dev
```

**The tape loads without a wallet.** Published prices and volumes are public by design, so a regulator or a passer-by can read the prints without connecting anything. A wallet is only needed to trade or to decrypt your own balances.

**Disconnect** clears this site's session and drops back to that public view. It asks the wallet to revoke via `wallet_revokePermissions` where MetaMask supports it, and otherwise clears our own state — a dapp cannot log you out of a wallet, only the wallet can. It also drops every account-derived value, including the cached handle client, because a client bound to one identity and reused under another mints proofs the contract rejects. The same rebuild happens automatically on `accountsChanged`.

Connected, the UI covers the whole path: **wrap** bonds through the Layer 2 custody boundary, **deposit** either leg into the venue's encrypted escrow, then post, fill, cancel, report and publish. Funding first matters — the venue holds escrow as raw handles, and an ask posted without shares behind it settles for **zero rather than failing**, because reverting on an encrypted shortfall would leak it.

The tape shows each print in one of four states, driven entirely by chain state: *unreported* → *price published, volume counting down* → *publishable now* → *fully printed*. Notional is deliberately withheld until both halves are public, because that gap is what the deferral actually creates.

---

### Deploying the frontend (Vercel)

The repository root is a monorepo with no `package.json`, so a default Vercel import finds nothing to build and serves `404: NOT_FOUND`. `vercel.json` at the root fixes that by pointing install, build and output at `frontend/`. No dashboard change is needed — but if you would rather configure it there, set **Root Directory** to `frontend` and delete this file, since the two approaches conflict.

The build also needs the `VITE_*` variables set in **Settings → Environment Variables**, because `.env.local` is gitignored and never reaches the build. Without them the app loads and tells you no deployment is configured:

```
VITE_VENUE, VITE_CHAIN_ID, VITE_SHARES_WRAPPER, VITE_CASH_WRAPPER,
VITE_NOX_GATEWAY_URL, VITE_NOX_SUBGRAPH_URL
```

> **Do not put a private RPC key in `VITE_RPC_URL` on a public deployment.** Vite inlines every `VITE_*` variable into the client bundle, so an Alchemy key there is readable by anyone who opens the page. Leave it unset — the app falls back to a public endpoint — or use a key you are willing to publish.

## Chains

`Nox.noxComputeContract()` hardcodes three chains. Anything else reverts `Nox: Unsupported chain`.

| Chain | ID | NoxCompute |
|---|---|---|
| Ethereum Sepolia | 11155111 | `0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF` |
| Arbitrum Sepolia | 421614 | `0xd464B198f06756a1d00be223634b85E0a731c229` |
| Hardhat local | 31337 | `0x75C6AF4430cc474b1bb9b8540b7E46D6f8e1C685` |

A hardcoded address proves the contract exists, not that the Ingestor and Runner serve that chain. Confirm with one real transaction.

---

## Testing

`npm test` in `nox/` runs 28 tests against a **real NoxCompute instance**. Because the SDK resolves NoxCompute from a hardcoded per-chain address, the harness deploys the contract from the package's own shipped artifact and installs it at that address with `hardhat_setCode`, then forges the gateway-signed EIP-712 input and decryption proofs. No Docker required.

**What the suite proves:** that every path executes, and that **ACL grants land** — asserted by reading `isAllowed`, `isViewer` and `isPubliclyDecryptable` from NoxCompute. Since a missed grant is the most likely bug in the project and produces a silent dead handle, this is the coverage that matters most. The disclosure regime is verified directly: `fill()` publishes nothing, `reportTrade` publishes price but not volume, and the deferral is enforced.

**What it cannot prove:** decrypted **values**. No TEE Runner runs locally, so no computed value ever materialises. Balance-correctness requires the real stack. **A green suite is not proof the arithmetic is right.**

---

## Status

Live on Ethereum Sepolia, no mocks in any demo path. See `deployments/*.sepolia.json`.

| | |
|---|---|
| Nox off-chain stack serves Sepolia | confirmed — round trip resolves in ~2s |
| Real T-REX (ERC-3643) suite | deployed, both wrappers registered as verified holders |
| Branchless fill arithmetic | verified on-chain across four real trades |
| Disclosure regime | verified: price at settlement, volume after the deferral |
| Public tape with live countdown | done |
| Holder register, grant on demand | done (`scripts/register-demo.ts`) |
| Auditor route | done — regulator-vs-public side by side, unreported fills, register |
| Compliance rejection on the encrypted path | done (`scripts/compliance-demo.ts`) |
| Contracts verified on Etherscan | done — source readable for venue + both wrappers |
| Chain of Trust | investigated — build provenance verifiable, per-fill attestation designed-not-shipped |

The auditor route shows the disclosure gap directly: for each fill, what the
regulator can decrypt beside what the public can currently see. A row is flagged
**gap open** whenever those disagree, which is precisely when the deferral is
doing its job. The public column distinguishes *withheld — deferred* from
*nothing, unreported*, because those are different failures of visibility.

It also lists **settled-but-unreported fills**. Reporting is an obligation on the
maker and the contract cannot compel it, so a missing print is detectable rather
than preventable — and the auditor, holding the quantity handle since the fill,
can see exactly what was omitted. `SKIP_REPORT=true` on `live-trade.ts` produces
one to demonstrate against.

Note that the regulator column is only populated when the connected wallet
actually holds the grants. Opened as anyone else it stays sealed, which is the
protocol rather than the page.

**Not built, deliberately:** anything resembling revocation. Nox has no
`removeViewer` and no persistent `disallow`, so a grant cannot be taken back.
Rotation is the honest mitigation and is tested (`does not extend a register
grant to the holder's FUTURE balances`), but it is not revocation and is not
claimed as such.

## Provenance

Written during the hackathon: `ConfidentialWrapper.sol`, `DeferralVenue.sol`, both deploy scripts, the demo script, the test suite and harness, and the frontend.

Pre-existing dependencies, unmodified: **T-REX / ERC-3643 v4.1.6** (`@tokenysolutions/t-rex`), **ONCHAINID v2.2.1**, **`@iexec-nox/nox-protocol-contracts` v0.2.4**, OpenZeppelin contracts.

Nothing in this repository is reused from the Vibe Coding hackathon.
