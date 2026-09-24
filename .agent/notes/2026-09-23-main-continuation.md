2026-09-23 public Pi continuation batch (local-only change record)

- Added explicit noninteractive continuation binding to one workspace and one M07 goal in the research extension. A successful goal begin in that workspace may bind a new goal; read-only status cannot.
- At agent_end, persisted goal status governs follow-up. Pi's own follow-up queue continues within the same session.prompt. Finished outcomes, provider failure, abort, and repeated empty rounds do not queue another model turn.
- On session shutdown, an unfinished bound goal is interrupted with a concrete reason. Unrelated active goals are not archived by a natural print exit. Archive faults are marked repair-required, while stage cleanup and telemetry cleanup still run.
- Private P3 launcher next-start profile passes continuation workspace and an optional explicit --goal-run-id; no real run was started.
- The queued continuation message carries the exact bound workspace as well as run ID, so a main Pi cwd outside the research workspace cannot route status to the wrong root.
- Offline verification: node --test test/pi-continuation.test.ts (9/9); npm run typecheck; private launcher offline check; git diff --check. No model or platform request.
