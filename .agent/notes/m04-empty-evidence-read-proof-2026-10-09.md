# Empty M07 evidence read proof in M04

The M04 required-read validator previously rejected a frozen zero-byte regular file before inspecting read events because it has no text lines. A complete empty-file proof now requires an actual `m07_evidence_read` event for the exact relative path with `no-content` status, text kind, no truncation, and no line range. Missing, misdirected, errored, binary, truncated, or invented-range events remain incomplete. Nonempty files retain their existing line-range and untruncated terminal-page requirements.

Offline regressions cover the accepted empty return, each rejected event shape, a default M04 entry with an empty required file, and the Pi runner's real empty-file event shape. This proves that the read tool returned no bytes in that session; it does not establish that the model used the evidence or that any scientific claim is correct. No live mission, provider call, or external publication was part of this change.
