# Interrupted source capability review v2

The earlier review grant described all model sessions as read-only, although an M07 builder has a factory-confined write grant. New host reviews now require receipt version 2 with separate fields for M07 builder writes and read-only objective, M04, and M07 reviewers. Each capability has its own immutable code and test evidence role. Version 1 receipts cannot mint a new capability.

The host adapter and supervisor use the new process-local brand. Durable journal records continue to bind the reviewed source, tree, and receipt digest without changing their schema. The separate prefix-backed review uses the same explicit evidence role vocabulary.

This change grants no authority to a draft, changes no scientific or accounting result, and creates no dispatch reservation. A real operator must inspect the exact interrupted source and submit an approved private receipt before the host can consider a fresh launch.

Verification: focused source-review, supervisor, and host-adapter tests passed (86 tests); TypeScript typecheck passed. Full clean acceptance and CI belong to the integration worktree.
