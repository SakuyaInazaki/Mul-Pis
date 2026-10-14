# Source-search target and JSON handoff repair

Real source development exposed two interface problems: the analysis session had no explicit code-edit objective or writable-file scope, and a valid builder hypothesis wrapped in a single JSON code fence was rejected before engineering checks.

The trusted caller now supplies the H or I editing target, objective, and writable files. Analysis messages, proposal callbacks, and search/selection receipts carry that same target. The improver still chooses its hypothesis and candidate. A shared JSON reader accepts raw JSON or one complete JSON fence, retains the original response, rejects ambiguous documents, and preserves the builder’s existing three required hypothesis fields.

The associated regression covers H/I target delivery and actual source generation with a fenced hypothesis. Experiment-specific observations and diagnostic scoring stay outside the reusable workflow.

Validation: typecheck passed; 21 directed source candidate/search/meta/arm checks passed; full offline suite passed with 1,629 tests passing, zero failures, and 16 skips (1,645 total).
