# Campaign stop classification (2026-10-04)

The first private M07 attempt reached one planned provider-request reservation, then ended with a failed task and no candidate. Its preserved status did not include the controller's failure classification or runner usage evidence, so the exact cause cannot be reconstructed from the retained artifacts. A reservation does not establish actual provider acceptance or billing.

The in-process campaign budget now exposes only a fixed, non-sensitive stop reason in its status snapshot: payload boundary, planning ceiling, usage reconciliation, or prompt failure. It does not store or export the provider response, prompt, input files, credentials, or raw error text. The private driver is responsible for preserving additional reviewed scalar diagnostics before its workspace cleanup; those are outside this runner change. This addition does not loosen a stop or refund a reservation.

Focused offline runner tests and typecheck passed. No paid retry was made in this change.
