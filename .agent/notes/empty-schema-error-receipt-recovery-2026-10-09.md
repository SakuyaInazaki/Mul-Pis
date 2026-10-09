# Empty schema-error receipt recovery

On 2026-10-09, the local evaluator return finalizer was corrected to treat an empty `schemaErrors` array as no schema error. A nonempty array on a passed check, a malformed array, or an unsupported check result remains invalid.

Offline regression coverage now starts from a sealed returned-result journal and verifies host-only receipt recovery, unchanged returned bytes, and no implicit goal selection or new model, builder, evaluator, or preflight call. Negative returned results remain rejected without re-entering the evaluator.

The change does not alter trusted evaluator versions, returned journal bytes, or scientific acceptance policy.
