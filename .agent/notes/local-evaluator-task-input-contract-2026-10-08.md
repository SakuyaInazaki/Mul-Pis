# Local evaluator task input contract

A trusted local evaluator may declare a versioned, data-only JSON task input contract. The host validates its bounded text and structured schema/example data at registration, freezes the exact declaration with mission, source-input, evaluator ID/version and content digests, and copies it into each future M07 task. The M07 task prompt points the worker at that exact frozen file before work. A changed declaration under the same evaluator version, a changed source identity, or forged frozen bytes holds dispatch. Historical missions without a declaration remain readable.

An evaluator may return bounded structured schema errors with artifact, path, and message. The host validates these against declared artifact paths and includes them in M07 review limitations and checkpoint feedback for the next repair pass. This adds no runtime fee, time, round, or output policy.

Offline tests cover delivery before builder work, registry and frozen-file rejection, identity changes across reopen, historical checkpoint reading, and actionable schema-error feedback. The private evaluator can later provide its own exact schema and examples through this generic interface.
