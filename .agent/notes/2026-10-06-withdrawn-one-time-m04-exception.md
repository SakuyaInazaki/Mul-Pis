# Withdrawn one-time M04 exception

A proposed hardcoded historical-source exception and its carry-forward authorization were denied during review before publication. The exact targets removed were `src/runner/ledger-continuation.ts`, `test/ledger-continuation.test.ts`, and the proposed one-time exception change note. At the withdrawal step, the ledger and its test file were restored byte-for-byte to the last reviewed commit. Subsequent generic append-only UNKNOWN-quarantine persistence changed those files without adding a historical source exception. No alternate source-shape or hash matcher was substituted, and no historical M04 proposal gained restart, merge, or scientific authority.

This removal is not a normal Git revert because the proposed branch had not been committed. Reintroducing any such authority would require a new explicit review and authorized implementation. No paid call or publication was made as part of the withdrawal.
