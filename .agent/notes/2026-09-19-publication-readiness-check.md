# Publication readiness check — 2026-09-19

## Result

The organized documentation baseline passes the local integrity and release-boundary checks. This does not initialize or publish a repository and does not select a project license or future self-improvement level.

## Integrity

- All 25 entries in `manifests/workflow-v1.0.sha256` pass after migration.
- The recorded pre-move and final SHA-256 values are identical for every workflow file; content was not rewritten.
- The local RSI v1 PDF remains unchanged at SHA-256 `9fde92cba4d50a38a42570c25b89fe116312f746659e560290d344ead91f7a9b`.
- Pi remains clean at `e4c75a73222ae2c72abb5f5314fa35ee8effc508`.
- SoL-Pi remains clean at `bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1`.

## Documentation

- Checked 20 Markdown files after both research reports and this acceptance record were written.
- Every local Markdown path target exists, including links inside the migrated workflow baseline.
- No migration-induced broken relative links were found, so no baseline file needed correction or an exception note.
- Public documentation and notes contain no machine-specific absolute workspace paths.

## Simulated public boundary

- The simulated file list prunes `third_party/`, `resources/`, and `.agent/private/` according to the intended `.gitignore` boundary.
- The simulated public tree contains 38 files and is about 375 KB; exact size may shift with documentation edits.
- No nested `.git` directory remains in that simulated tree. The two local nested repositories exist only under ignored `third_party/`.
- A signature scan found no common private-key or provider-token pattern in the simulated public tree.
- The source PDF and both upstream checkouts remain available locally and are represented publicly only by provenance, versions, and checksums.

## Remaining owner decisions

- Select the project license before public release.
- Review the organized result before Git initialization, remote creation, commit, or push.
- Decide later whether and how much workflow self-improvement to authorize; this preparation pass makes no such choice.

## Final cross-day recheck — 2026-09-20 (Asia/Shanghai)

- Scope: all 38 files in the simulated public tree after pruning `third_party/`, `resources/`, and `.agent/private/`.
- Checked all 20 public Markdown files against that pruned file set, rather than the local filesystem alone. Every relative link target is included in the public tree; no link relies on an ignored local PDF or checkout.
- Rechecked workflow hashes, both upstream checkout SHAs and clean status, nested Git exclusion, common secret signatures, and machine-specific absolute paths; all passed.
- Removed the re-created legacy `Pi/` path with `rmdir` after confirming it contained directories only and no files or symbolic links. The active checkout remains at `third_party/pi/`.
