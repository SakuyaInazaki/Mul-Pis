# Terminal carry verifier

Added a read-only verifier for the latest completed private campaign Actions run. It reuses the signed seed, live run order, terminal job and provider step, exact encrypted carry artifact, AEAD checkpoint, ancestry, and selected-transition checks. It exposes a separate process-local brand and a bundle-bound redacted supervisor projection. The terminal path rejects absent carries, unsupported legacy checkpoints, changed objective text, missing selected-tuple provenance, and newer completed runs. It does not seal a successor carry or claim a restart admission.

The proof stores the exact bundle digest privately. A carried `fulfilled` label cannot be re-proved from the checkpoint alone because the original-check closure inputs are not preserved there, so this verifier refuses to project completion until an independent host closure receipt exists.

The redacted projection also includes the SHA-256 of the exact authenticated objective checkpoint bytes so a later host-derived action can cite that source without claiming the older ciphertext itself carried the action.

For a terminal control-ref push, the verifier identifies the accepted feature source from the submitted request commit's immutable first parent, compares the exact commit trees, and requires a completed successful push regression for that source SHA. This keeps a valid finished request readable after the feature branch advances. Running admission continues to require the live feature ref. Mocked regressions cover the advanced ref, changed tree, and missing successful CI.

Added a focused mocked GitHub and signed-seed regression covering a valid terminal projection and failures for source, actor, artifact, authentication tag, ancestry, and newer completed run. The existing ledger continuation tests remain passing.
