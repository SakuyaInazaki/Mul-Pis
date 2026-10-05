# Preserve explicit M07 reviewer and decision evidence

## Reason for change

The private M07 archive previously kept only a short reviewer-feedback field. Feedback longer than 2,000 characters or eight lines was marked `excluded` and vanished when the temporary workspace was removed. That loses explicit review rationale even when candidate bytes and measurement summaries survive.

## Change

- Preserve complete visible, structured reviewer feedback for each bounded round in a private `round-N-reviewer-feedback.txt` file, and the complete visible reviewer report in a separate `round-N-reviewer-report.md` when its controller-owned source file exists. The JSON manifest remains an index; a short inline preview is optional and never replaces the complete file. No hidden provider thinking or session JSONL is included.
- Preserve explicit controller review checks, failures, unexecuted items, limitations and independent-check disposition in `review-decision.json`. Ephemeral evidence file paths are not represented as restored artifacts.
- Redact credential values within these private text files without dropping surrounding scientific rationale. A 512 KB per-file hard limit fails the archive operation explicitly rather than calling missing rationale a normal archive outcome.
- Validate named feedback/report/decision files and byte lengths on archive load. Extend the encrypted result transport allowlist for the base, initial, follow-on and same-goal branch variants, with the same 512 KB hard bound on those files at encryption and decryption. The driver exports/remaps these files and discloses fallback archive failure before removing temporary work.
- The encrypted allowlist also includes the driver's fixed, scalar-only `context-lineage.json` and the initial candidate's explicit `initial-m04-adopted-knowledge.json` provenance copy. Transport roundtrip tests cover both names; the driver owns creation and semantic validation of their contents.

## Verification

- Focused archive and context tests passed, including a >2,000-character multi-line reviewer rationale, visible reviewer report, decision disposition, credential redaction, oversized feedback refusal and load refusal when a named file is missing. Python encrypted transport tests passed 8/8 with branch-prefixed reviewer files and the same hard bound. Integrated typecheck passed after the changes; the full suite is being rerun alongside concurrently edited M07/CLI tests.
- The files are private transport artifacts; this note contains no private research content, credentials, model transcript or upstream source bytes.
