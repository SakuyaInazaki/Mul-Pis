# Repository reorganization — 2026-09-19

## Approved boundary

- Prepare the local directory, root documentation, agent rules, ignore rules, documentation index, provenance, and reproducibility checks.
- Preserve the workflow baseline byte-for-byte.
- Keep the local Pi checkout and source PDF available, while excluding them from the intended public release.
- Do not initialize Git, create a remote, commit, push, choose a license, or modify Pi source.

## Changes

- Moved `科研执行流程_v1.0/` to `workflow/v1.0/` without editing its files.
- Moved `Pi/` to `third_party/pi/` without editing its files or removing its installed dependencies.
- Removed the root `.DS_Store`. It is regenerable macOS metadata and is now covered by `.gitignore`.
- Added root `README.md`, `AGENTS.md`, `.gitignore`, documentation index, provenance record, and workflow checksum manifest.
- Added `.agent/private/` as the ignored location for private notes. Publishable work records remain under `.agent/notes/`.
- Shallow-cloned the official SoL-Pi reference to `third_party/sol-pi/` for read-only research. No dependencies were installed and no repository script was run.

## Fixed inputs

- Pi upstream: `https://github.com/earendil-works/pi.git`
- Pi commit before and after move: `e4c75a73222ae2c72abb5f5314fa35ee8effc508`
- SoL-Pi upstream: `https://github.com/NVlabs/SoL-Pi.git`
- SoL-Pi commit: `bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1`
- Source PDF SHA-256: `9fde92cba4d50a38a42570c25b89fe116312f746659e560290d344ead91f7a9b`
- Workflow file hashes: `manifests/workflow-v1.0.sha256`

## Publication boundary

- Publish root documentation, workflow baseline, checksum manifest, research reports, and publishable agent notes after review.
- Exclude `third_party/`, `resources/`, and `.agent/private/`.
- A project license remains a required owner decision before release.
- The degree of future workflow self-improvement remains undecided; this pass performs organization, research, and validation only.

## Empty-path cleanup authorization record

- Target: the re-created legacy `Pi/` directory tree containing only empty `docs/research/` and `.agent/notes/` directories.
- Reason: concurrent agents retained the pre-move working directory and recreated directory placeholders after the checkout moved to `third_party/pi/`; retaining the empty legacy path would make the final layout ambiguous.
- Verification before removal: `find Pi -type f -o -type l` returned no entries.
- Recovery: only empty directories are removed; they contain no data and can be recreated if needed. Removal uses `rmdir` only, so it fails rather than deleting a non-empty directory.
