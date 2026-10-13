# M07 formal evidence snapshot and temporary work repair

This change repairs a generic M07 host failure after an execution builder returned. The extension now exposes the persisted execution failure, branch unavailability reason, and last round's available report and snapshot paths in task and goal summaries. Credential-shaped values in these diagnostic strings are redacted in the tool summary.

The M07 round snapshot, builder-report handoff, and branch evidence freeze no longer reject formal work at an arbitrary 64,000,000-byte aggregate threshold. They still copy the complete formal work tree, reject links and special files, preserve per-file byte observations and byte equality checks, and retain the existing branch authentication-file filter. The separate checkpoint transport bound and prompt/provider limits are unchanged.

New execute tasks receive a controller-created disposable directory outside their formal work tree. Its path is persisted in the execution tool grant and passed as TMPDIR to isolated bash. The task prompt directs disposable caches and browser profiles there while requiring scripts, measurements, receipts, negative findings, reproduction data, and final evidence in formal work. Each branch gets its own directory. Existing session specs without this field remain supported. No historical task or active session is migrated or cleaned up.

Offline regression coverage checks a formal evidence file above 64 MB through review and branch freeze, exclusion of disposable files, distinct branch directories, actual bash TMPDIR behavior, visible failure diagnostics, and retention of the full builder report when snapshot validation fails. Existing mutation, path, and permission checks remain in the targeted suite. No real model or network call was made.

Review adjustment: scratch paths use a fresh controller-created directory per delegation attempt. A setup failure before task persistence can leave disposable files, but must not make the next use of that task identifier fail with EEXIST or reuse stale temporary state.
