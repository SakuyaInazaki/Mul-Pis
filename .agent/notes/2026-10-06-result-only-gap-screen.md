# Result-only gap structural screen

Added an offline, non-authoritative structural screen for an Actions result whose encrypted carry is absent. It checks the predecessor's original objective and bounded-run prefix, a no-new-goal host census, and consistent aggregate accounting, then returns only hashes, observed aggregate amounts, and an unresolved request-ID census. It cannot reconstruct request-level usage or charges and does not mint restart authority. Production use still requires independently authenticated Actions source, terminal job, artifact archive, encrypted-result provenance, and predecessor carry, followed by a separate reviewed bridge in the ledger.

Synthetic tests cover a passing read-only result and fail-closed cases for missing or duplicate request IDs, changed accounting, an active transport, a changed objective or selection, a mismatched predecessor digest, and an execution grant. No paid model calls were made; offline tests made no network calls.
