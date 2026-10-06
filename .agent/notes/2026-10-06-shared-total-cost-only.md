# Shared total monetary ceiling only

Date: 2026-10-06

## Authorized change

The user clarified that a campaign's single total monetary limit is the only monetary gate. Phase, role, branch, pilot, protected-check and retry allocations must not split that total or stop work while the root account still has usable funds. Existing scientific case definitions, file safety limits and private paid-campaign ledger are outside this batch.

## Implementation

- SharedBudget child leases now serve solely as usage and lifecycle namespaces. A child status shows its own committed and reserved usage, but its monetary limit and remaining balance are the shared root's. Historical child limit arguments cannot enforce independent monetary caps.
- Prompt admission checks pending or unknown usage and the root remaining balance. Actual provider spending can overshoot a request's estimate without creating a separate per-request monetary limit; only overshoot of the campaign root makes settlement exceeded. In-flight and unknown usage still block further paid requests.
- Research phase preflight validates the frozen phase topology and scientific cases, creates accounting leases, and seals topology. It no longer sums or preallocates phase/branch ceilings.
- Research plan decoding accepts historical phase-budget fields but discards them. Active research uses only the required campaign total budget; improver pilot lease creation no longer depends on a separate pilot allocation.
- The Pi extension guidance now asks for one total SDK-estimated-cost ceiling, rather than provider-call, token, and per-phase monetary ceilings.
- Documentation now identifies the single total budget and states that an unbounded in-flight provider turn can exceed the SDK-estimated total before settlement. This ledger blocks subsequent work and promotion after observed exceedance; it is not a hard prepaid transport stop or provider invoice guarantee.

## Offline verification

- Focused synthetic tests cover an old phase monetary sum exceeding the root cap without rejection, spend beyond an old child cap, sibling sharing of the same remaining balance, and root exhaustion blocking further requests. Existing tests cover unknown/in-flight settlement.
- No models, paid calls, uploads, commits or pushes were made for this batch.
