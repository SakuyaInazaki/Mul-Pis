# Result-only repair diagnostic migration

A completed run may have an authenticated terminal AEAD carry whose checkpoint
requires workflow repair, while the optional `repair-state.json` appears only
inside its RSA-encrypted result. The host may use that one diagnostic after an
operator decrypts and reviews the exact result privately. The AEAD bundle,
selected research, accounting, pending action, and unresolved operations stay
unchanged.

The private operator receipt must live outside the checkout in a mode-0600
regular file. It names the terminal source and tree; the authenticated carry
envelope, checkpoint, contract, selected tuple, and pending-action digests;
the exact live GitHub result artifact ID and ZIP digest; the SHA-256 of the
downloaded RSA envelope; and the byte-exact decrypted `repair-state.json`
text and its SHA-256. Its review fields assert an operator performed the RSA
decryption and used the result only for this control diagnostic. The host
cannot independently prove the operator's decryption claim. The result's
scientific contents are never adopted through this route.

The read-only host bridge requests the exact result artifact through its
existing authenticated connector. The connector checks the ZIP against the
live digest and returns only the private local encrypted envelope file and
its digest. The host rechecks file mode, file digest, envelope metadata and
byte format, then compares the envelope digest to the receipt before minting
a process-local repair-state verifier brand. A separately reviewed workflow
repair plan must match those exact repair-state bytes, authenticated pending
action stage, and the current tested source and CI. The constant-message
public descriptor contains no receipt or result bytes. A missing, altered,
or unreviewed result keeps dispatch blocked.

The historical pending action may be a reconciliation action with unresolved
M07 references even when its reason is workflow repair. The repair plan is
required by the authenticated stop reason; it does not relabel or clear that
action. A subsequent Actions runner still admits the prior AEAD checkpoint
without requiring the optional repair-state file.
