# Feedback on iExec Nox tooling

Written while building, not reconstructed afterwards. Everything below was hit
in practice on `@iexec-nox/nox-protocol-contracts@0.2.4`. Points are ordered by
how much time they cost.

---

## 1. `select` has no `ebool` overload, and there is no `ebool → euint` cast

The single most consequential gap. `Nox.select` is overloaded for `euint16`,
`euint256`, `eint16` and `eint256` — but not `ebool`. There is also no boolean
operator anywhere in the `Operator` enum (Add, Sub, Mul, Div, Safe\*, Select, Eq,
Ne, Lt, Le, Gt, Ge, Transfer, Mint, Burn) and no cast from `ebool` to an integer
type.

**Consequence: you cannot AND two encrypted booleans at all.** Any contract that
needs a conjunction of encrypted conditions — which is most non-trivial
contracts — has to restructure so the *value* is gated through nested selects
and zero propagates downstream:

```solidity
euint256 qtyGated = Nox.select(a, Nox.select(b, qty, ZERO), ZERO);
```

That is a workable idiom, but it is not obvious, and discovering it late forces
a rewrite of the core settlement path. **Suggestion:** either add an `ebool`
overload for `select`, or add `and`/`or`/`not`, or — cheapest — document the
nested-select-on-value idiom prominently in the SDK reference, because right now
a developer finds this out from a compiler error.

## 2. No revocation primitive, and this is not stated up front

The complete ACL surface is `allow`, `allowTransient`, `disallowTransient`,
`addViewer`, `allowPublicDecryption`. There is **no `removeViewer` and no
persistent `disallow`.**

So persistent grants and public decryption are **permanent and irreversible**.
We had planned a demo beat around revoking an auditor's access; it cannot be
built. Revocation-by-rotation (move the value to a fresh handle, re-grant
selectively) is the only mitigation, and it is undermined by point 4 below.

**Suggestion:** state this in the first paragraph of the ACL documentation. It
is an architectural constraint that changes what applications are possible, not
a missing convenience method.

## 3. The Admin/Viewer split is real but asymmetric, and `allow` is a trap

`allow()` grants admin, and `isViewer()` returns true for admins — so admin ⊇
viewer, and `allow()` on a human "works" for decryption. It is also the wrong
call: `_isAllowedPersistent` checks the admin set only, so an admin can use the
handle as a computation input and re-grant it to others.

Worse, in combination with point 2: **rotation revokes viewers but never
admins.** A stray `allow()` on a person makes them *permanently unrevokable*,
and nothing in the API signals that at the call site.

**Suggestion:** rename `allow` to something that says "admin" (`allowAdmin`),
or document the asymmetry next to both functions. The current naming makes the
least-privilege choice the non-obvious one.

## 4. Result handles are deterministic when any operand is private

`_generateHandleUniqueSeed` returns `0` whenever any operand is private — the
uniqueness counter only engages when *all* operands are public. No timestamp,
caller, or block number enters the derivation.

So `add(x, ZERO)` returns the **same handle every time**. This is surprising,
and it partially defeats revocation-by-rotation: you cannot rotate the same
value twice against the same party, because the "fresh" handle is identical.

**Suggestion:** document this explicitly. It is reasonable behaviour for
caching, but it interacts badly with the rotation pattern that point 2 forces
developers into.

## 5. `Nox.transfer` is a value primitive, and the name misleads

`transfer(balanceFrom, balanceTo, amount) → (success, newFrom, newTo)` takes no
addresses and calls no token contract. Everyone reads `transfer` as a token
call; it is closer to `applyDelta`.

The important consequence is easy to miss: **every transfer mints three new
handles, and the old balance handle stops being current state.** Forget to
re-grant the new ones and the owner silently goes blind on their own balance.

A genuinely useful detail that *is* well designed: `success` already encodes
`balanceFrom >= amount`, so no separate `safeSub` is needed for a funding check.
That deserves to be called out in the docs — we nearly wrote a redundant one.

## 6. Missing an ACL grant fails silently, and looks exactly like async lag

This is the highest-severity developer-experience issue. A handle without a
persistent grant is not an error — no revert, no event, nothing. It simply
cannot be decrypted later. From a frontend it presents as an empty balance,
which is **indistinguishable from the Runner being backed up.**

**Suggestion:** anything that helps here would be valuable — a `hasGrants(handle)`
view, an event on handle creation without grants, or a Hardhat-plugin warning
when a transaction produces handles that end the transaction ungranted. We ended
up asserting `isAllowed`/`isViewer` in tests specifically to catch this class of
bug, and would guess most teams do not.

## 7. Documentation diverged from source on several points

During planning, the published docs contradicted the actual 0.2.4 sources on
four separate points — the `select`/`ebool` question, the semantics of `allow`
vs `addViewer`, the existence of revocation, and which chains are supported.
The source was right every time.

Notably the docs did not make clear that **Nox is deployed on Ethereum
Sepolia** (`0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF`); we found it by reading
`noxComputeContract()`. That is a meaningful fact to leave to source-diving.

**Suggestion:** generate the API reference from the Solidity source, or add a
CI check that the documented surface matches the SDK.

## 8. `viaIR` is effectively mandatory and nothing says so

Our `fill()` — one branchless settlement path, roughly forty lines — does not
compile without `viaIR: true`: stack too deep. This is a predictable consequence
of the nested-select idiom that point 1 forces, since each intermediate handle
is a live stack variable.

**Suggestion:** ship `viaIR: true` in the starter template's Hardhat config, and
say why. Discovering this mid-build costs a slow recompile cycle at the worst
moment, and the error message points at Solidity, not at Nox.

## 9. `toEuint256` is not `pure`, which is easy to misuse

`Nox.toEuint256` (and the other `to*` helpers) call NoxCompute via
`wrapAsPublicHandle`, so they are state-changing. The natural reading of
"convert a constant to an encrypted constant" is that it is free and `pure`.

Used carelessly — per call, inside a loop — this is a real gas cost. The right
pattern is to build encrypted constants once into an `immutable` at deploy.

Also genuinely nice and worth advertising: `bytes32(0)` auto-resolves to a typed
zero handle via `_resolveUndefinedHandle`, so an uninitialised `euint256` *is* a
usable zero. That saved us a constructor call, and we only found it in source.

## 10. The shipped `NoxCompute` artifact exceeds EIP-170

`artifacts/contracts/NoxCompute.sol/NoxCompute.json` cannot be deployed to a
default local chain — "code too large". It is evidently built for the production
(optimizer + `viaIR`) profile. Testing against a locally deployed NoxCompute
requires `allowUnlimitedContractSize: true`.

**Suggestion:** either ship an artifact built with the optimizer, or note the
required network setting beside it.

## 11. Local development requires Docker, which narrows who can test

The local stack runs through a Docker-based Hardhat plugin. On a machine without
Docker there is no documented path to running Nox contracts locally at all.

We worked around it: deploy `NoxCompute` from the shipped artifact, install it at
the SDK's hardcoded local address with `hardhat_setCode`, initialise it with a
known gateway key, and forge the EIP-712 input and decryption proofs in the test
helper. That gives real ACL and control-flow coverage with no Docker — it cannot
resolve computed values, since there is no Runner, but grant correctness and
disclosure state are exactly what we most needed to test.

**Suggestion:** ship something like this as an official lightweight test harness.
A mock-Runner mode that resolves handles synchronously would be even better, and
would let teams assert arithmetic in CI. This is the single highest-leverage
addition we can imagine for Nox's developer experience.

## 12. The subgraph indexes handles, not the application's own events

`@iexec-nox/handle` ships a `subgraphUrl` per network, and the natural assumption
is that it is a general indexer for the deployment. It is not — it indexes Nox
handles, so it cannot be used to enumerate an application contract's own events.

That matters more than it sounds, because hosted RPCs restrict the alternative:
Alchemy's free tier rejects any `eth_getLogs` spanning more than 10 blocks, so
`queryFilter(filter, 0, "latest")` is not available either. We ended up adding
explicit `ordersCount()` / `fillsCount()` view functions and paging by index.

That is the right answer anyway, but it is worth stating in the docs, because the
combination — no app-level indexing, no wide log queries — is easy to discover
late, after the frontend is already written against events.

**Suggestion:** say plainly what the subgraph covers, and recommend on-chain
counters for application state.

## 13. Public RPCs break Nox deploys specifically

Not an iExec bug, but worth documenting for anyone following the guides. A Nox
contract deploy is unusually transaction-dense: `Nox.toEuint256` in a constructor
is a real external call, and a single `fill()` fans out to ~25 NoxCompute calls.
Against a load-balanced public endpoint, `eth_getTransactionCount` returned stale
values between sends, producing `replacement transaction underpriced` and then
`nonce too low` on consecutive transactions.

Five rapid pending-nonce reads against a single-node provider agreed every time;
the same pattern against the public endpoint did not.

**Suggestion:** the quickstart should recommend a single-node RPC, and the
starter template should track nonces locally. A half-completed deploy is an
expensive way to learn this.

## 15. `publicDecrypt` trails the chain, and reads as a failure when it does

After `allowPublicDecryption` is mined, the on-chain ACL is public immediately —
`isPubliclyDecryptable` returns true in the same block. But `publicDecrypt` goes
through the gateway, which reads the ACL via an indexer that trails the head, so
for a few seconds it still refuses the value.

The refusal is indistinguishable from "this handle is not public", which is the
same conflation as point 6 in a different guise: a timing state presenting as a
permission state. We briefly believed our own `publishVolume` had failed, and only
established otherwise by reading `isPubliclyDecryptable` from NoxCompute directly.

**Suggestion:** raise a distinct, typed error for "public but not yet served" the
way `NotYetComputedHandleError` already does for computation. The information is
available — the indexer knows its own lag, and `SubgraphOutOfSyncError` exists in
the codebase for a related case. Anything that lets a caller tell *wait* from
*denied* would do.

## 14. `createViemHandleClient` ignores the wallet client's bound account

The highest-severity issue we hit in the JS SDK, and the one most likely to bite
anyone testing with more than one party.

`ViemBlockchainService` resolves the signer as:

```js
const addresses = await this.walletClient.getAddresses();
const address = addresses[0];
```

It reads `getAddresses()[0]` and **ignores `walletClient.account`** — even though
the very next method uses `this.walletClient.account` for signing. With a Hardhat
wallet client that is a silent correctness bug: all configured keys share one
transport, `eth_accounts` returns every one of them, and so *every* party's
client reports the first account. We handed `encryptInput` a client for the taker
and got a proof bound to the deployer.

The failure is far from the cause. The gateway happily signs the proof, and the
transaction reverts on-chain inside `validateInputProof` with a bare
**`0xae385f38`** — a custom error with no string, no ABI entry in the application
contract, and no indication that the owner was wrong. We only found it by
decoding the raw 137-byte proof by hand and noticing the first 20 bytes were the
wrong address.

Workaround: build a dedicated `createWalletClient({ account, chain, transport })`
per party so `getAddresses()` returns exactly one address.

**Suggestion:** prefer `walletClient.account?.address` and fall back to
`getAddresses()[0]`, which is a two-line change and matches what the signing path
already does. Failing that, throw when `getAddresses()` returns more than one
account. And please give `InvalidProof` a reason string that distinguishes owner
mismatch from app mismatch from expiry — the on-chain `require`s already carry
those strings internally, but the custom error discards them.

---

## Live-stack notes (Ethereum Sepolia, 30 July 2026)

Recording these because they are the numbers we could not get from documentation.

**The off-chain stack on Ethereum Sepolia is fast.** A full round trip —
`encryptInput` → `depositCash` (132,789 gas, one `Nox.add`) → `decrypt` —
returned the correct plaintext **~1.8 seconds** after the transaction was mined.
We had budgeted 60 seconds. Whatever the docs imply about TEE-async latency, the
practical experience on this chain is close to interactive.

**The ACL model behaves exactly as the source suggests.** `viewACL` on the
resulting handle returned:

```json
{ "isPublic": false,
  "admins":  ["0x…the venue contract"],
  "viewers": ["0x…the depositor"] }
```

`allowThis` for the contract and `addViewer` for the human produced precisely the
least-privilege split we wanted, with nothing public. This is the first thing we
would point a new Nox developer at, because it makes the admin/viewer
distinction concrete in a way the prose does not.

**Measured gas, for anyone sizing a deployment:**

| Operation | Gas |
|---|---|
| `DeferralVenue` deploy (incl. one `toEuint256`) | 1,523,481 |
| `ConfidentialWrapper` deploy | 1,157,495 |
| `depositCash` (one `Nox.add`) | 132,789 |
| `postAsk` (2 `fromExternal`, 1 transfer, 6 grants) | 360,713 |
| `fill` (~25 NoxCompute calls) | 784,211 |
| `reportTrade` (one `allowPublicDecryption`) | 65,598 |

`fill()` is the expensive one and still only ~2% of a Sepolia block, which was
better than we feared given how many external calls the branchless pattern
forces. Worth publishing something like this: "is my confidential contract going
to fit in a block" is an early, load-bearing question and currently unanswerable
without building the thing.

---

## What worked well

- **Handle layout is clean and self-documenting.** Version, chain id, type, and
  attribute bits packed into `bytes32`, documented in `HandleUtils`. Decoding a
  handle by hand while debugging was straightforward.
- **The `safe*` family returning `(ebool success, euintN result)`** is the right
  shape, and the security invariant comment on `isPublicHandle` — spelling out
  that public handles bypass every ACL gate — is exactly the kind of comment
  that prevents a vulnerability.
- **`_resolveUndefinedHandle`** making uninitialised storage behave as a typed
  zero removes a whole category of initialisation boilerplate.
- **Per-chain address resolution in the SDK** means application code carries no
  network configuration at all. Being unable to override it did not hurt, and it
  made the "unsupported chain" failure mode loud and early.
- **`allowThis` as a distinct call** is a good affordance once the admin/viewer
  asymmetry is understood.
- **`@iexec-nox/handle` needs no configuration on a supported chain.**
  `createEthersHandleClient(signer)` resolves gateway, contract address and
  subgraph from the chain id alone, and `NETWORK_CONFIGS` in the source is a
  clear, readable statement of what is deployed where. After the friction of
  source-diving the Solidity side, this was a pleasant surprise.
- **`NotYetComputedHandleError` as a distinct error type** is exactly right. It
  makes "the Runner has not got to it yet" programmatically distinguishable from
  a real failure, which is what lets a UI show a pending state instead of an
  error. Given that async lag and a dead handle otherwise look identical from the
  frontend (point 6), this typed error is doing a lot of work.
- **`encryptInput` binding the proof to (owner, app)** is a good design. Getting
  it wrong fails loudly with "App mismatch" rather than silently, which is the
  opposite of the ACL failure mode and much easier to debug.
