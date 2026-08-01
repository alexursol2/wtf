# Continuing DEVEN from another machine

Everything needed to pick this up cold. Read `README.md` for what the project
*is*; this file is about getting it running and knowing where the work stopped.

---

## 1. Get it running

```bash
git clone https://github.com/alexursol2/wtf.git
cd wtf/venue
```

Three sub-projects, each with its own `node_modules`:

```bash
cd trex     && npm install && cd ..
cd nox      && npm install && cd ..
cd frontend && npm install && cd ..
```

### Secrets you must recreate

Neither env file is in git. Both are required.

**`venue/.env`** — used by the `trex` and `nox` Hardhat projects:

```
RPC_URL=https://eth-sepolia.g.alchemy.com/v2/<your-key>
PRIVATE_KEY_DEPLOYER=0x...
PRIVATE_KEY_MAKER=0x...
PRIVATE_KEY_TAKER=0x...
PRIVATE_KEY_AUDITOR=0x...
ETHERSCAN_API_KEY=...
```

The four keys must be four *different* addresses — `fill()` and `hit()` both
reject a self-trade, because with maker == taker both sides of a transfer land in
one storage slot and the second write silently wins.

A public RPC works but is rate-limited enough to make the frontend look broken.
Use a private endpoint (Alchemy free tier is fine).

**`venue/frontend/.env.local`**:

```
VITE_VENUE=0x3c8e8e37f81cd211c6a9509513bebc5e0ff41d76
VITE_CHAIN_ID=11155111
VITE_NOX_GATEWAY_URL=https://gateway-testnets.noxprotocol.dev
VITE_NOX_SUBGRAPH_URL=https://thegraph.ethereum-sepolia-testnet.noxprotocol.io/api/subgraphs/id/9CsccKwvgYFo72zZeU4k4wj2NEBLdWhVE3EUandgmzgo
VITE_SHARES_WRAPPER=0x28bf0728213275b52c3285a1423bd7e51acb4dd8
VITE_CASH_WRAPPER=0x89ef295d85401890736e9b07e7498e4b77531e63
VITE_BOND_TOKEN=0xb0ba5244DF094160Ff31E523Fa5F8a51124f94E7
VITE_CASH_TOKEN=0xb956f6651ec9d7d53c89ae4fb3068988f660b4db
```

Then:

```bash
cd frontend && npm run dev      # http://localhost:5174
```

Check the wallets have gas before doing anything on-chain:

```bash
cd nox && npx hardhat run scripts/check-accounts.ts --network sepolia
npx hardhat run scripts/fund-accounts.ts --network sepolia   # tops up from deployer
```

---

## 2. Live deployment (Sepolia)

| What | Address |
|---|---|
| **DeferralVenue (current — no expiry, 1h deferral)** | `0x3c8e8e37f81cd211c6a9509513bebc5e0ff41d76` |
| DeferralVenue (retired, two-sided with expiry) | `0x97239e7f58ff1795991949961deb32794422eaf8` |
| DeferralVenue (retired, ask-only) | `0xa55b6ed5d1f8a93343b60fe2cb3a0746e5069569` |
| IdentityRegistry (shared by all 3 tokens) | `0x9eF9D65E08Acc1fc91bF2815409Ac6782e20eF66` |
| Auditor / regulator | `0xACc8D0072bB98eA0764704D1CA585140Fa981cc7` |
| Cash token | `0xb956f6651ec9d7d53c89ae4fb3068988f660b4db` |

Instruments — **the order of this list is load-bearing**: `Order.instrument` is a
`uint8` index into `INSTRUMENTS` in `frontend/src/reference.ts`. Appending is
safe; reordering silently re-labels every existing order.

| # | Symbol | Token | Wrapper |
|---|---|---|---|
| 0 | ACME30 | `0xb0ba5244DF094160Ff31E523Fa5F8a51124f94E7` | `0x28bf0728213275b52c3285a1423bd7e51acb4dd8` |
| 1 | AAPL.rwa | `0xDd2B5764dE8C58e2ab1482606bDDE5EdFb9BAf53` | `0xd673ad276a0ea96d346fd6727cee8cd8074826cc` |
| 2 | TSLA.rwa | `0x275E645aF19e67BA5575E76814F4ecC14362d982` | `0x758c57f15cd6090426ed25ebe15a1cc4f2844a9b` |

`deployments/venue.sepolia.json` and `deployments/trex.sepolia.json` are the
source of truth and are committed.

---

## 3. What the last redeploy changed

Two contract changes, both requiring a redeploy because they touch the `Order`
struct and a constant:

- **`expiry` is gone from `Order`.** `postAsk` and `postBid` no longer take it,
  `fill` and `hit` no longer check it, and `OrderPosted` carries
  `(side, instrument)` instead. It was never a working feature: every caller set
  a lifetime past any horizon that mattered, so nothing ever expired, and the
  only place it surfaced was a timestamp in the book that nobody could act on.
  Orders now rest until cancelled, which is what they already did.
- **`LIS_DEFERRAL` is 3600, not 90.** The visibility control offers Immediate /
  1 hour / Never, with **1 hour as the default** — an hour is short enough to
  wait out in a demo and long enough to be a real deferral. Anything other than
  the contract's own constant would be a delay the UI promises and the chain
  does not enforce, since `publishVolume` is callable by anyone once the
  deadline passes.

Everything the previous redeploy added is unchanged and still live: `Side` on
`Order` (`postBid` / `hit`), the plaintext `uint8 instrument`, `withdrawCash` /
`withdrawShares`, and the auditor's circuit breakers.

Frontend changes that needed no contract work:

- **Market orders carry a 2% price collar.** They used to send a bid of `1e12`
  (crosses any ask) or an ask of `1` (accepts any bid), and settlement charges
  the RESTING price — so an absurd quote was paid in full. Now they send
  `reference × (1 ± 2%)` and the contract's own crossing test does the work.
- **The taker's unfilled remainder is rested automatically.** After a fill the
  UI decrypts the executed quantity (the taker holds the viewer grant), reports
  what actually traded, and posts the difference as a resting order.
- **Escrow withdrawal is wired.** The wallet panel has *Withdraw from escrow*
  (venue) beside *Unwrap* (wrapper). They are different boundaries and were
  being conflated.

46 contract tests pass (`cd nox && npx hardhat test`).

### Re-seeding after a redeploy

A redeploy starts an **empty book** — orders and fills live in the venue's own
arrays and are not migrated.

```bash
cd nox
npx hardhat run scripts/fund-accounts.ts --network sepolia    # seeding costs ~0.02 ETH per side
npx hardhat run scripts/redeploy-venue.ts --network sepolia   # venue only, keeps wrappers
# put the new address in frontend/.env.local AND in the Vercel project's env vars
npx hardhat run scripts/seed-book.ts --network sepolia        # ~18 orders + 6 prints, ~10 min
npx hardhat verify --network sepolia <VENUE> <IDENTITY_REGISTRY> <AUDITOR>
```

`seed-book.ts` builds three asks and three bids per instrument, quoted from BOTH
accounts, and then trades once on each side of each book. Three things about it
are deliberate and worth keeping if you edit it:

- **Both accounts quote both sides.** `fill` and `hit` reject a self-trade, so a
  book where one address holds every ask is untradable by that address.
- **Levels sit inside the frontend's 2% collar**, or a market order cannot reach
  them and the button looks broken.
- **The seeded trades are partial and the orders are reopened afterwards.** A
  fill parks its order in `PendingResolution` until the maker clears it, so
  without the `reopen` the traded levels vanish from the book.

Other scripts: `deploy-instrument.ts` (trex — new ERC-3643 token reusing the
registry), `deploy-instrument-wrapper.ts` (nox — its wrapper), then
`register-holder.ts` (trex) to whitelist the wrapper as a holder of record.
`seed-instrument-orders.ts` and `seed-instrument-fills.ts` are gone: they
predated the instrument field, called a signature the contract no longer has,
and hardcoded order ids from a retired deployment.

---

## 4. Things that will bite you

**A failed trade looks like nothing happening.** Settlement is branchless: if
escrow is short by even one unit, the transfer's success flag is false, the
quantity is selected to zero and the trade settles for *nothing* — no revert, no
error, because a revert would leak the shortfall. If a trade "did nothing",
suspect funding first. This is why the UI applies a 0.5% buffer.

**Signature prompts.** The Nox gateway authorization is signed once and reused
for an hour, but only if it is persisted — the SDK defaults to in-memory storage
that dies on reload. `frontend/src/handleStorage.ts` backs it with localStorage
and `getHandleClient()` attaches it. Decrypts are also serialised, because
concurrent ones all find an empty store and all sign. Break either and you get
~20 MetaMask popups.

**`getComputedStyle` right after a click lies.** Buttons have a background
transition, and the in-app browser pane does not composite frames when hidden, so
a colour read immediately after a toggle returns the *old* value. Disable
transitions before asserting on colour, or you will chase a bug that is not there.

**Struct index drift.** `orders()` and `fills()` return positional tuples. The
tests name the slots in `ORDER` / `FILL` constants at the top of
`test/venue.test.ts` — keep using those. A positional read after a struct change
fails *silently*.

**The auditor sends no transactions** and is intentionally unfunded. It only
signs decryption authorizations off-chain.

---

## 4a. Backing escrow with the wrapper — designed, not built

`depositShares` still credits a self-declared amount. Wiring it to real custody
is not a one-line change, and the reason is worth writing down before anyone
starts.

**`confidentialTransfer` cannot be used as-is.** It moves from `msg.sender`, so
the venue calling it would move the *venue's* balance. The user pushing first and
the venue crediting afterwards does not work either: the amount is a ciphertext,
so the venue cannot verify what actually arrived.

**What it needs is an operator path on the wrapper:**

```solidity
mapping(address => mapping(address => bool)) public isOperator;
function setOperator(address op, bool ok) external;

/// Only an operator the holder approved. Returns the amount ACTUALLY moved.
function operatorTransfer(address from, address to, externalEuint256 encAmount, bytes calldata proof)
    external returns (euint256 moved);
```

The return value is the load-bearing part. `Nox.transfer` moves zero when the
holder is short, so an operator transfer that credited the *requested* amount
would leave escrow unbacked in exactly the case that matters. Returning
`Nox.select(success, amount, ZERO)` lets the venue credit precisely what moved:

```solidity
euint256 moved = wrapper.operatorTransfer(msg.sender, address(this), encAmount, proof);
escrowShares[msg.sender] = Nox.add(escrowShares[msg.sender], moved);
```

**The part that makes it a real project rather than a patch:** escrow is
currently one balance per address, but there are three instruments with three
wrappers. Backed escrow has to become `escrowShares[account][instrument]`, which
touches `postAsk`, `postBid`, `fill`, `hit`, `cancel` and `withdrawShares` — and
means redeploying **both** the wrapper and the venue, re-registering the wrappers
as holders of record, and re-seeding.

Cash has the same gap and the same fix, against the cash wrapper.

Budget it as: wrapper change + venue change + tests + two redeploys + re-seed.
Do not start it without room to finish — a half-wired escrow settles trades to
zero silently, which is the worst failure this codebase has.

---

## 5. Known limitations (deliberate, documented)

- **Escrow is not backed by the wrapper.** `depositShares` credits a
  self-declared amount and never calls `ConfidentialWrapper`. Settlement between
  parties is exact; what is missing is the link tying escrow to real custody.
- **Amount-gated compliance is not enforced on the encrypted path.** Identity and
  country are re-enforced in the wrapper; max-balance / max-transfer rules would
  need a readable comparison against an encrypted balance.
- **Grants are permanent** — Nox has no `removeViewer`. Mitigation is rotation,
  not revocation.
- **An order can never be known to be exhausted**, since `qtyRemaining` is
  ciphertext. Partial-fill bars are drawn only from a size *this browser*
  recorded at post time; other orders read "size sealed" rather than guessing.
- **Visibility delay is one hour or immediate**, not arbitrary — `LIS_DEFERRAL`
  is a contract constant, so a different length is a redeploy. "Never" is real,
  and is simply never calling `reportTrade`; the regulator's unreported list is
  what catches it.
- **The 2% market collar is a FRONTEND rule.** The contract enforces whatever
  encrypted bid or ask it is handed; the collar is the frontend choosing that
  number honestly. A caller going straight to the contract can still send a bid
  of `1e12`. Making it a contract rule would need a plaintext reference price on
  chain, which this venue does not have — there is no oracle and the book is
  dark.
- **Indicative prices** (`reference.ts`) are issue-level reference data for
  instruments that have not printed yet, labelled as such. They are never
  presented as market prices.

---

## 6. Where the work stopped

Done and verified live: two-sided book with three levels a side in every
instrument, per-instrument books and prints, market buy and sell inside a 2%
collar, automatic resting of a taker's remainder, escrow withdrawal, inline
auto-funding, execution safety guard, portal tooltips, 3-column layout, buy/sell
theming, regulator blotter + circuit breakers.

Not done:

- **The frontend still shows a single merged book.** Rows now carry a bid/ask
  pill, but they are one list sorted by id. A proper depth ladder — bids one
  side, asks the other — needs no contract work.
- **`reopen` is still manual.** After a fill the order sits in
  `PendingResolution` until the maker confirms; the contract cannot read its own
  encrypted result to clear it. The seeding script calls `reopen` itself, but a
  maker trading through the UI still has to press the button. Auto-reopening
  after a fill is the obvious follow-up and needs no contract change.
- **The remainder is rested by the FRONTEND, in a second transaction.** It
  cannot be done inside `fill`: the contract cannot read how much of an
  encrypted quantity it just moved, so it cannot know what is left to rest. If
  the executed size has not resolved when the user walks away, nothing is
  posted — the UI says so rather than guessing.
- **No subgraph.** Orders and fills are enumerated by index off `ordersCount()` /
  `fillsCount()`, one `eth_call` each. With 18 orders and 6 fills a refresh is
  already ~50 sequential calls on a public RPC and takes several seconds; it is
  linear from here.
