# Local workflow repair acceptance checkpoint

This is a source-only, offline engineering checkpoint. The exact tested commit is `b21cd110fc5a1d4675a796befc9938c34ad55379`, tree `1d184167d28659de8e32352f3f7447e8b741bbf6`. Tests ran in a detached checkout of that commit with only a cached `node_modules` symlink untracked. No live DeepSeek request, private experiment execution, cloud task, GitHub Actions run, or remote publication is claimed here.

- Full direct Node suite: 1,551 passed, 0 failed, 0 skipped, exit 0; local evidence log `mul-pis-node-b21cd11.log` (SHA-256 `b2672ac7f915f2c2607fd855af678671f94425514227f55c2ec01c7929b61da6`).
- Direct TypeScript `tsc --noEmit -p tsconfig.json`: exit 0; empty log `mul-pis-tsc-b21cd11.log`.
- Local Python suites: 22 + 4 + 9 = 35 passed, exit 0; log `mul-pis-python-b21cd11.log` (SHA-256 `b4a0a7d9ee358075772c709dd494f3c0d1a75173fcd366c9ef516256230909cd`).

The earlier integrated `12d5e686499d04e8020ed964a0ae9876f99f02cb` full Node run finished 1,507 passed and 21 failed. Those failures exposed accepted-review same-step and V4 recovery mismatches, which were repaired and independently source-reviewed. Later `cb614cb`, `c2d731b`, and `b311579` full Node attempts were interrupted as incomplete because old synthetic assessors or M04 reviewers deliberately returned provisional replies indefinitely after a production repeat-count stop was removed. Their fixture-owned explicit aborts are recorded separately; no production attempt limit was restored. The `b21cd11` detached run completed after those fixture corrections.

These results show the local harness can execute and recover the covered synthetic workflow cases. Real authenticated provider behavior, scientific correctness and optimality, arbitrary long-term persistence, and cross-machine migration of a live mission remain separate evidence requirements. A 64 MiB physical checkpoint-file bound and repeated-M04 history/prompt growth remain known long-run storage issues under active repair. Historical receipts and UNKNOWN effects retain their existing fail-closed checks.
