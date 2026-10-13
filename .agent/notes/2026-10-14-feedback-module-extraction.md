# M07 feedback module extraction

Extracted the existing full M07 feedback writer into `src/m07/feedback.ts`. The controller still validates the goal's frozen policy and retains goal review, fulfillment, feedback fallback, checkpoint and archive decisions. The new module receives that validated policy and preserves the original feedback body, output path, projection event and write order.

The existing projection capture helpers now live once in the trusted `src/m07/projection.ts` module and are imported by both the controller and feedback writer. Editing the replaceable feedback module does not change task input projection. Workflow text, evaluator rules, knowledge limits, third-party checkouts and the live research session are unchanged.

Verification: TypeScript typecheck passed. Focused offline M07 feedback, checkpoint, failed-baseline and controller tests passed (67/67) with host process identity access. A first sandboxed run could not read macOS `kern.boottime`; its failures occurred before the changed code was exercised.
