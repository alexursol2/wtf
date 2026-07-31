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
VITE_VENUE=0x97239e7f58ff1795991949961deb32794422eaf8
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
| **DeferralVenue (current, two-sided)** | `0x97239e7f58ff1795991949961deb32794422eaf8` |
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

The venue was ask-only. Four separate feature requests all turned out to need the
same contract change, so they were done together:

- **`Side` on `Order`** — `postBid` rests a bid escrowing cash; `hit` sells into
  one. The book is genuinely two-sided, so **market sell executes** instead of
  being a marketable limit with nothing to hit.
- **`uint8 instrument` on `Order` and `Fill`** — plaintext, because *which*
  security is quoted is not the secret (the size and price are). Replaced a
  localStorage tag map plus a shipped seed map that could never cover orders from
  another browser.
- **`withdrawCash` / `withdrawShares`** — escrow could previously only be
  emptied by trading it away.
- Circuit breakers (`setPaused`, `setFillFrozen`) were added earlier and are now
  live for the first time; the retired venue predates them.

47 contract tests pass (`cd nox && npx hardhat test`).

### Re-seeding after a redeploy

A redeploy starts an **empty book** — orders and fills live in the venue's own
arrays and are not migrated.

```bash
cd nox
npx hardhat run scripts/redeploy-venue.ts --network sepolia   # venue only, keeps wrappers
# put the new address in frontend/.env.local
npx hardhat run scripts/seed-book.ts --network sepolia        # bids + asks + a trade each side
npx hardhat verify --network sepolia <VENUE> <IDENTITY_REGISTRY> <AUDITOR>
```

Other scripts: `deploy-instrument.ts` (trex — new ERC-3643 token reusing the
registry), `deploy-instrument-wrapper.ts` (nox — its wrapper), then
`register-holder.ts` (trex) to whitelist the wrapper as a holder of record.

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
- **Visibility delay is 90s or immediate**, not arbitrary — `LIS_DEFERRAL` is a
  contract constant. "Never" is real, and is simply never calling `reportTrade`;
  the regulator's unreported list is what catches it.
- **Indicative prices** (`reference.ts`) are issue-level reference data for
  instruments that have not printed yet, labelled as such. They are never
  presented as market prices.

---

## 6. Where the work stopped

Done and verified live: two-sided book, per-instrument books and prints, market
buy and sell, inline auto-funding, execution safety guard, portal tooltips,
3-column layout, buy/sell theming, regulator blotter + circuit breakers,
withdrawal.

Not done:

- **The frontend still shows a single merged book.** The contract now
  distinguishes bids from asks (`Order.side`), but `renderBook` lists them
  together. A proper depth ladder — bids one side, asks the other — is the
  obvious next step and needs no contract work.
- **`reopen` is still manual.** After a fill the order sits in
  `PendingResolution` until the maker confirms; the contract cannot read its own
  encrypted result to clear it.
- **Withdrawal is wired to the wrapper's unwrap**, not to venue escrow. The
  contract now has `withdrawCash` / `withdrawShares` but the UI does not call
  them yet.
- **No subgraph.** Orders and fills are enumerated by index off `ordersCount()` /
  `fillsCount()`, one `eth_call` each. Fine at this size, linear as it grows.
