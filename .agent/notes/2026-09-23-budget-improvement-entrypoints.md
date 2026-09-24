# Budget improvement entrypoints and public boundary

- Added the separate Pi and CLI entrypoints for the bounded budget-policy improvement service.
- Documented automatic offline promotion, rollback, fixed evaluator ownership, development-replay limits, and claims that remain unverified.
- Excluded local improvement candidates, evaluations, promotion records, and rollback records from Git and public pushes.
- Updated generic extension and CLI tests without using a real model or network.
- Aligned implementation documentation with the final absolute inline-coverage gate, cross-process mutation lock, promotion baseline comparison, and per-goal frozen policy behavior including legacy-goal refusal.
- Final closeout verified legacy goals remain inspectable and can only be interrupt-archived with control-facts-only feedback; normal delegation and completion remain blocked without a frozen policy snapshot.
- Verification passed TypeScript checking, 51 focused offline tests, Git diff whitespace checks, ignore-rule checks for improvement and note records, and a public-diff sensitive-pattern scan.

This note contains no research-task content, model output, platform identity, credential, or machine-specific path.
