# M07 projection snapshot ownership during failed copies

Changed `copySnapshotBounded` so it acquires the destination with an exclusive open before starting the copy streams. A destination that already exists now returns `EEXIST` without deleting the earlier snapshot. After this call has created a destination, a budget or source-stream failure still removes its partial copy.

Added `test/m07-projection.test.ts` with direct temporary-file checks for an existing destination, a partial over-budget copy, a failing source stream, and a successful copy. The integrated TypeScript typecheck passed. The complete offline suite reported 1,654 tests: 1,638 passed, 16 skipped, zero failed, including all four new regression cases. No real model or network call was used.
