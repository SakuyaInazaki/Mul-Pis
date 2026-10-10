# Research history entry locator

- Added a generic control locator for entries in the rendered, range-readable UTF-8 history projection.
- The locator scans JSON syntax and records exact entry byte spans, crossed part ranges, local line ranges, safe goal/task identifiers when present, and file-name keys. Nested strings cannot masquerade as entry metadata.
- It rejects malformed JSON, invalid UTF-8, and missing, overlapping, or out-of-bounds part coverage. The locator is only a reading aid; historical evidence still requires reading the staged bytes.
- Added offline tests for multiple entries, nested quoted IDs, cross-part entries, UTF-8 boundary cuts, exhaustive entry coverage, and malformed inputs. No network or model calls were made.
