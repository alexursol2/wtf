# Submission copy

Draft text for the X post and the submission form. **Post it yourself** — this file
is a draft, not an action.

Every public description leads with the **disclosure schedule**, never with
privacy. Most competing submissions open with "amounts stay hidden"; by the time a
judge reaches the ninth one saying that, the sentence has stopped carrying
information. The schedule is the part nobody else is doing.

---

## X post — primary draft

> Most confidential DeFi hides data. A trading venue has to do the harder thing:
> decide *when it stops being hidden.*
>
> We built an RFQ venue for tokenized bonds where disclosure runs on a schedule
> enforced by the protocol.
>
> Price prints at settlement. Volume prints when the deferral elapses. The
> regulator sees the size from the first block — before the public does.
>
> Modelled on the MiFIR transparency regime, both halves. Live on Ethereum
> Sepolia, built on @iEx_ec Nox.
>
> [video] [repo]

Character count sits comfortably under the limit with a link and a video card.

## Shorter variant, if the thread format is tighter

> An RFQ venue for tokenized bonds where disclosure is a schedule, not a switch.
>
> Price prints at settlement. Volume prints after the deferral. The regulator is
> ahead of both, from block one.
>
> Both halves of the MiFIR transparency regime, as a contract. Live on Sepolia,
> built on @iEx_ec Nox.

## What to say if asked "so what's private?"

Lead with the schedule, then answer the question directly:

> Pre-trade: order sizes, prices, balances, remaining depth. Post-trade: volume,
> until the deferral elapses. What's deliberately public: the executed price at
> settlement, and the deferral flag itself — declaring a fill large-in-scale
> announces that it was large, exactly as under the real regime.

## The differentiator, in one line

> Nobody is in the matching decision. Not the venue operator, not iExec, not the
> TEE runner. Settlement is branchless, so there is no actor who learns whether an
> order crossed — which is the asymmetry dark pools exist to remove and most
> designs quietly reintroduce via a gateway callback.

## Phrasing rules

- **"Modelled on the MiFIR regime"**, never "compliant with". A judge who knows the
  regime will respect the hedge and punish the overclaim.
- **Do not claim novelty.** Confidential ERC-3643, the wrapper pattern, the
  three-layer stack and encrypted RFQ all exist. The assembly is ours; "novel
  combination" is the weakest available claim.
- **Do not say "fully private"** anywhere. The leak model in the README is explicit
  and the submission should not contradict it.
- iExec's own vocabulary, used where it actually fits: *programmable privacy*,
  *selective disclosure*, *auditability on demand*, *privacy without breaking
  composability*.

## Verifiable claims, with where to check them

Every one of these is checkable by a judge from a clean clone:

| Claim | Evidence |
|---|---|
| Live on Ethereum Sepolia, no mocks in the demo path | `deployments/venue.sepolia.json`, `usesMocks: false` |
| Real ERC-3643 suite, wrappers registered as holders | `deployments/trex.sepolia.json` |
| Fill arithmetic correct on-chain | `scripts/live-trade.ts` — 8 assertions on decrypted values |
| Settles at the maker's price, not the taker's bid | same script, stated in its output |
| Regulator sees volume before the public | `scripts/live-trade.ts`, and the auditor route |
| Deferral actually enforced | `scripts/publish-volume.ts` refuses while deferred |
| Register sealed until disclosed | `scripts/register-demo.ts` |
| Country rule enforced on the encrypted path | `scripts/compliance-demo.ts` — reverts with `"country"` |
| Attestation scoped honestly | `scripts/attestation-check.ts` |
| Source is readable, not just bytecode | verified on sepolia.etherscan.io |

## Deliverables checklist

- [x] Public repo that clones and runs
- [x] README: install, deploy, architecture, leak model, limitations, `PRICE_SCALE`
- [x] Built-during-hackathon statement (see Provenance)
- [x] Working frontend, no mock data — reads verified; **write path needs one manual MetaMask test**
- [x] Deployed on chain
- [x] `feedback.md` on iExec tooling
- [ ] Demo video, 4 min max — **teammate**
- [ ] X post tagging @iEx_ec — **post yourself**
- [x] Nothing reused from the Vibe Coding hackathon
