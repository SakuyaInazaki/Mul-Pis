# Confidential Actions transport (2026-10-04)

This batch adds a generic, manually reviewable workflow and a Python transport for a bounded private campaign. It does not include private inputs, a private decryption key, a lab-specific filename, or any real campaign result. No live run was launched in this batch.

The input arrives only through the existing repository Actions secret. The decoder trims outer ASCII whitespace, strictly validates Base64, caps compressed and expanded size, requires exactly three flat regular tar members, rejects duplicate names, links, path escapes and unsafe path syntax, and writes validated files with private permissions into a fresh runner temporary directory. It never logs file names or contents.

The workflow installs the official Ubuntu `bubblewrap` package and runs offline checks before decoding, scopes the model credential to the campaign step, redirects private stdout and stderr to runner-local temporary files, and uploads only an encrypted envelope. The result archive uses a fixed three-file allowlist: `candidate.cpp`, `verification.json`, and `campaign-status.json`. AES-256-GCM encrypts the tar archive with authenticated, non-private GitHub run metadata. An ephemeral AES key is wrapped to the repository's public RSA-3072 key with OAEP-SHA256. The recipient public key's SPKI SHA-256 fingerprint is pinned in the workflow, preventing silent substitution. The corresponding private key is kept outside this repository and the hosted runner.

The initial trigger permits only an exact branch/actor/commit-message push marker with the first run attempt. It has read-only repository permission, no dependency cache, and one-day ciphertext artifact retention. The campaign driver must fail closed on its own budget and OS isolation preflights before any paid calls. The Actions workflow and transport alone do not provide candidate-code execution isolation. A later campaign would need a fresh authorization, cumulative accounting, and a separately reviewed trigger.

The same public transport script has a local-only `decrypt` command, intended for use outside the checkout with the separately retained private key. It checks the recipient key, authenticated run metadata, archive type, allowlist and size caps, then writes into a fresh private directory. The workflow never calls this command or receives the private key.

Verification: generic Python tests cover legitimate Unicode/parenthesized paths, private modes, strict Base64, traversal, links, duplicates, compressed-size limits, key size, allowlist exclusion, authenticated encryption roundtrip and tampering. These tests use only synthetic data and an ephemeral test key.

## Authentication finding and trigger cleanup

The direct, read-only official model-list credential probe returned HTTP 401 in the controlled Actions run. It stopped before private task staging or model generation. The synthetic real-Pi tool-request regression independently verifies the SDK endpoint and Authorization construction using only a fixture key and an intercepted transport; it does not validate any live credential. A currently accepted credential is still required before the real optimization can finish. No candidate or performance gain is claimed.

Removed the temporary push trigger. The retained manual entry defaults its explicit bounded-run confirmation to false, and each manual run must be accounted separately against any total user-approved budget. Keeping an entrypoint does not authorize another model run. No private input, private key or raw authentication error is published in this note.
