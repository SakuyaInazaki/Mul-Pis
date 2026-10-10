# Context lineage proof repair

## Change

- The private campaign now checks the two exact frozen evidence bindings emitted by the M07 controller: the checkpoint manifest uses the checkpoint ID, while the original problem snapshot uses the parent run/task identity. Extra, reordered, stale or mismatched bindings fail closed.
- The next guarded campaign uses a 5.3 CNY hard cap. Historical settled spend and gross reservations remain separate; neither a cheaper cache settlement nor a valid Pi fork is inferred from a loose provenance label.

## Verification

- Offline lineage tests include a controller-shaped positive receipt and negative manifest version, problem version, problem path and extra-binding cases. TypeScript typecheck and focused private-campaign tests pass. No paid call or private task content is part of this change.
