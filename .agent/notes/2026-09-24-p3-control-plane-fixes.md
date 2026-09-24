# Private workflow launcher control fixes

- Changed the main log resource ceiling to apply to the current run only. Older retained logs no longer prevent a new run. A warning receipt is written once at 48 MiB; the current run still stops beyond 64 MiB.
- Checked the main model and role models against one explicit high/low contract before launch.
- Registered an active run with the existing local monitor discovery directory when it is present. A conflicting registration fails closed; normal exit removes only this launcher's exact link.
- Added a bounded local log-tail utility. It reads at most 64 KiB from the active private main log. Its output can contain private content and must remain local.
- Extended the synthetic offline launcher check to cover retained old logs, model mismatch, and bounded reading. The check passed.
- No external dependency preflight was added: the launcher has no existing safe, read-only service health interface with stable semantics. A new platform-specific probe requires a separate contract.
- This does not add automatic checkpointing before a hard stop or recovery of a stopped research goal. The current-run 64 MiB ceiling remains a hard stop.
