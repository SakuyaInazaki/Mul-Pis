# Preserve structured source-builder hypotheses

The source builder can return nested descriptive claim and prediction objects even when the receipt expects text. The parser now preserves nonempty objects as JSON text in the existing fields and records the complete original answer. Empty, null, array and missing top-level hypothesis fields still fail validation. This does not change scientific evaluation or candidate admission.

The builder prompt states the preferred string representation and carries the existing minimal, task-independent editing constraints, including the restriction on arbitrary count, cost, time and output caps.

Validation: typecheck and all 23 targeted source-candidate/search/arm/meta checks passed. The full offline suite completed 1,647 tests: 1,630 passed, 16 platform-specific skips and one process-identity timeout during host sleep. The sole failed longevity test passed in a separate awake-host rerun without source changes. Real experiment outcomes remain in their private run records.
