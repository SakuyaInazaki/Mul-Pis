# Repository audit — 2026-09-19

## Scope and constraints

- Read-only inventory for preparing the project for open source.
- Do not delete source material, modify Pi source, initialize or publish a repository, or create commits.
- Prefer archiving over deletion. Only remove regenerable clutter after its status is confirmed.

## Current layout

- `Pi/`: 355 MB checkout of `https://github.com/earendil-works/pi.git`, branch `main`, aligned with `origin/main` at `e4c75a7`; working tree clean at audit time.
- `科研执行流程_v1.0/`: 352 KB workflow source, including 5 handbook chapters, 15 prompt files, compiled handbook, manifest, and coverage JSON.
- `resources/2609.11873v1.pdf`: 7.3 MB source paper.
- Root `.DS_Store`: 12 KB regenerable macOS metadata.

## Repository and policy findings

- The project root is not a Git repository.
- `Pi/.git` is the only nested Git repository found.
- The only applicable policy file found is `Pi/AGENTS.md`; it governs changes inside `Pi/` and prohibits commits unless requested.
- `Pi/node_modules` is present and accounts for most of the checkout size. It is ignored by Pi and reproducible from its lockfile.
- No Git submodules are configured in Pi.

## Large files and sensitive-data scan

- The only project-owned file over 1 MB outside Pi dependencies/build output is `resources/2609.11873v1.pdf` (7.3 MB).
- Pi contains expected upstream fixtures, documentation images, Git objects, and generated build output over 1 MB.
- A filename scan found no `.env`, private-key, credential, or secret files outside expected Pi source/test filenames.
- A content scan for common private-key and provider-token signatures found no matches outside Pi Git metadata, dependencies, and the PDF.

## Cleanup candidates

- Root `.DS_Store` is safe to remove once a root `.gitignore` is installed.
- `Pi/node_modules` is regenerable but should not be removed until the desired distribution model for Pi is chosen.
- Pi build output should remain untouched because Pi is an upstream checkout and outside the workflow implementation scope.

## Proposed organization (pending implementation boundary)

- Keep `Pi/` intact as an upstream harness checkout; document its exact revision and upstream URL rather than rewriting its source.
- Move the workflow content to a stable ASCII path such as `workflow/`, preserving the Chinese filenames inside it for continuity.
- Keep the paper under `resources/`; add a machine-readable source/provenance manifest with URL, version, SHA-256, and intended role.
- Add root `README.md`, root `AGENTS.md`, `.gitignore`, `LICENSE`/licensing notes, and `docs/research/`.
- Add a reproducibility manifest recording the Pi commit and source-paper checksum.
- Treat the nested `Pi/.git` deliberately when the root repository is eventually created: use a documented external clone/bootstrap step or a Git submodule. Do not accidentally commit it as an opaque embedded repository.

## Actions taken

- Created `.agent/notes/` and this audit record.
- No source, workflow, dependency, Git, or research files were changed.
