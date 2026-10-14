# Preserve nested headings when verifying inline evidence

Real source-arm calibration found a completed M07→M04 handoff marked unread by the fixed parent evaluator. The full frozen report was present in the M04 message, but the evaluator treated the report's own Markdown headings as the end of its artifact section.

Match the complete frozen text at the artifact body start after the controller inventory line. Retain exact bytes and the existing range-read checks; quoting another artifact elsewhere does not establish its delivery. Extend the source-arm integration fixture with nested report headings to exercise the real feedback renderer and parent evaluator. Original calibration receipts remain unchanged; later reevaluation records the corrected evaluator separately.

Validation: typecheck and the source-arm integration regression passed. Full offline suite: 1,642 tests, 1,626 passed, 0 failed, 16 skipped.
