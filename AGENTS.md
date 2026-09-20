# Project Working Rules

## Scope

- This repository is a documentation and research baseline for a general scientific workflow carried by the Pi agent harness.
- Do not claim that a runtime research engine or self-improving research system exists unless executable evidence is added and verified.
- The current research-execution layer uses `workflow/v1.0/` as its original baseline. Current stage alignment is recorded in the “当前对齐” section of `docs/research/workflow-foundation.md`; RSI and workflow self-improvement are later topics, not current execution-layer rules.

## Workflow ownership

- `workflow/v1.0/` is the user's own workflow and the direct foundation for continued research and evolution.
- Changes to the workflow must follow the user's current request and preserve relevant history, but the directory is not an immutable imported artifact.
- Put research mappings and implementation guidance under `docs/` when they are supporting material rather than workflow content.
- Do not introduce file-hash manifests or hash-verification workflows unless the user explicitly requests them.
- Do not publish private logs, credentials, internal competition identity data, or material without redistribution rights.

## Third-party and local-only material

- `third_party/` contains local upstream checkouts. Do not modify their source from this repository task.
- Follow a checkout's own `AGENTS.md` for any separately authorized work inside it.
- Keep `third_party/`, `resources/`, and `.agent/private/` out of public release artifacts.
- Record third-party URLs, licenses, versions, and full Git commit hashes in `docs/provenance.md`.

## Change records

- Record every project change batch, including documentation, configuration, migration, and deletion, in `.agent/notes/`.
- Notes intended for publication must omit machine-specific absolute paths, credentials, raw chat transcripts, and private identity data.
- Before destructive operations, record the exact target, why removal is necessary, and whether it is recoverable. Prefer archiving when practical.

## Collaboration

- For work on this Codex repository, the main agent owns requirement clarification, implementation-design judgment, orchestration, and acceptance. This does not move the workflow's substantive M04 scientific judgment away from the research session and model to be chosen later.
- Prefer delegating bounded implementation, large code reads, bulk changes, and tests to execution subagents when the environment supports them.
- The model requested for execution in the current Codex project session is `gpt-5.6-sol`.
- These collaboration rules do not assert that Pi already provides the same subagent behavior and do not select a future Pi model-routing design.

## Current implementation boundary

- Study how Pi can carry the workflow's existing rules before proposing implementation architecture.
- Extension, SDK, model routing, workflow-improvement loops, and the degree of self-improvement remain later decisions pending research and user choice.
- No runtime implementation is authorized in the current organization and research phase.

## Git and release

- For the current preparation pass, initialize a repository, create a remote, commit, and push only after the user accepts the organized result. In later work, follow the authorization scope of the active request.
- Do not choose a project license on the user's behalf.
- Before release, simulate the public file list and confirm local-only material and nested `.git` directories are excluded.
