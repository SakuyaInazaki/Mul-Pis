# Fresh-process workflow source arms

Added a fixed-source process boundary for the existing M07→M04 workflow arm. The host verifies the selected read-only source and full commit before launch; the child verifies its loaded entry before constructing a runner. The arm returns its loaded-source identity and process ID, which the host checks against the selected source and launched child.

The host retains pre-prompt checks and the provider-use ledger through a narrow IPC exchange. A child failure or missing settlement leaves the arm incomplete and records unknown usage. Recovery and continuation bindings from an unrelated process are removed from the child environment. The fake runner requires a trusted host-supplied offline reply module; plan and case data do not choose executable code.

This is a source execution and observation primitive only. Existing v1 `contains`/`forbids` checks still inspect the original M07 task report, not M04 judgment quality. The change does not admit source candidates or switch an active source pointer.

Offline verification exercised two distinct fixed source revisions through fresh M07→M04 processes with the same frozen method, knowledge, and model configuration. The source-comparison entry used four fresh child processes in alternating execution order and left the active research pointer unchanged. Mismatched source, missing runner, and a child crash with an unsettled provider turn were rejected; the crash recorded unknown usage. Typecheck and the focused test passed.
