# Accept a unique JSON handoff alongside code examples

Model source explanations can contain a complete TypeScript example before the single JSON result. The handoff parser now recognizes complete code blocks, ignores non-JSON examples and parses the unique JSON document. A longer surrounding fence prevents a nested example from becoming the answer. Ambiguous or incomplete JSON still fails; no extra model calls or retry framework is added.

Regression checks cover the real response shape, unchanged raw JSON, ambiguous and incomplete documents, and nested example fences. Typecheck and 24 targeted checks passed. The full offline suite completed 1,650 tests: 1,634 passed, zero failed and 16 platform-specific skips.
