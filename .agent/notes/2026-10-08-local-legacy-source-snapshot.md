# Offline source verification for one legacy review

The reviewed legacy mission recovery checked an older Git commit at runtime. A shallow checkout lacked that object, so the legacy recovery tests failed before reaching their evidence checks.

This batch includes a deterministic gzip snapshot of the eight public source files used by that narrow serial-dispatch review. The verifier checks the snapshot's fixed byte length and SHA-256, exact historical commit and tree labels, exact file set and order, and each reviewed file's SHA-256. The snapshot is source evidence for this one versioned migration; it contains no research input, model output, account material, or executable recovery authority. The active mission, its historical evidence, and its selected scientific state are untouched.

Verification includes a changed-snapshot rejection test and the complete affected legacy review suite in a single-commit offline checkout with no older Git object. Typecheck and the broader test suites are recorded with the release acceptance.
