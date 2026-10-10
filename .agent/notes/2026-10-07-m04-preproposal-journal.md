# M04 preproposal journal correction

The M04 host transaction now starts as `no-proposal` with zero attempts. It changes to `unknown` durably immediately before the knowledge store's proposal submission entry. A failed model prompt before that entry therefore leaves a portable, exact record that no proposal was submitted, while submission and merge uncertainty remain fail closed.

An offline regression throws during the first M04 prompt, checks that the failed run exports a zero-attempt `no-proposal` transaction with an unchanged knowledge snapshot, and then starts a fresh M04 session over the frozen M07 evidence. The existing merge-exception regression still checks durable `merge-intent` and no automatic retry.

Verification: the focused M04 test file passed all 11 tests, TypeScript typecheck passed, and `git diff --check` passed. This batch does not change the portable transaction schema or historical import rules. The known interval after a structurally valid proposal submission and before the merge call still records `merge-intent` conservatively and needs a separate cross-module design to distinguish a validated unmerged draft.
