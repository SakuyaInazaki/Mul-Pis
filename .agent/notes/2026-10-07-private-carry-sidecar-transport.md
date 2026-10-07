# Private carry sidecar transport

The private campaign workflow uploads the encrypted continuation root together with encrypted numbered sidecars. The artifact selection uses only the exact continuation filenames and keeps the earlier root-only artifact layout compatible. The encrypted outcome transport also includes only exact numbered sidecar basenames in its allowlist, so a recovered encrypted result can retain the ciphertext when the separate carry artifact is unavailable.

The authenticated host bridge accepts a private root file reference and optional numbered sidecar references from its connector. It validates private regular files, bounded sizes, file digests, exact names, unique contiguous indices, and canonical ciphertext encoding before handing them to the ledger. Existing root-only carry replies remain supported. The bridge emits only public metadata requests and the public control descriptor.

Offline tests exercised multi-sidecar and root-only authenticated resume, missing, duplicate and tampered sidecars, the workflow upload selection, and encrypted result allowlisting. No provider or live GitHub request was made.

The v4 ledger stores the whole checkpoint as ordered encrypted segments with at most 1 MiB of decompressed plaintext per segment. Its current in-memory logical checkpoint ceiling is 64 MiB and the carry artifact ZIP reader ceiling is 96 MiB. The separately encrypted result tar also has a 96 MiB combined ceiling: output files and base64 sidecars count together, so that transport can fill before the logical checkpoint reaches 64 MiB. These are physical transport capacity failures, not scientific success or fee-stop conditions. Legacy v1–v3 carry decoding retains its original raw bundle limits.

Normal and emergency v4 sealing measure the fully assembled checkpoint before segmenting it. If only a newly appended optional transport diagnostic crosses the logical ceiling, sealing keeps the authenticated older diagnostic, rebuilds the affected normal carry facts or updates the emergency bundle, and preserves the request audit. A failed normal retry restores the original prepared diagnostic state before emergency sealing.
