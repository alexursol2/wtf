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
