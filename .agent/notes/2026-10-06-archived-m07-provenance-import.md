# Archived M07 provenance import

This change adds a bounded, authenticated carry import for a historically accepted M07 candidate whose M04 evidence handoff did not complete. The archived source is untrusted development input, not a restored M07 run, current review, adopted lesson, or selected replacement for the prior mission candidate.

The importer checks the exact original contract, bounded-run and task identity, historical review claim, independent verification claim, archive byte lengths, and unsettled operation references. It stages source, historical verification, and an optional plan into a fresh private workspace directory. It does not reconstruct the unavailable old review snapshot or lesson.

A fresh M07 provenance goal must reproduce the imported source and plan byte-for-byte, pass current host verification, and receive an ordinary controller review. M04 then reads the new frozen review evidence in a fresh session and alone decides whether any knowledge operation is warranted. The prior canonical mission source and archive remain selected until a separate supported comparison changes that decision. The unchanged original-objective assessment continues after this missing-evidence stage.

Offline synthetic tests cover authenticated import, rejected or mismatched inputs, fresh controller review, M04 evidence reading, and preservation of the canonical selected tuple. No private task text, model credential, provider fee, or confidential source is included here.
