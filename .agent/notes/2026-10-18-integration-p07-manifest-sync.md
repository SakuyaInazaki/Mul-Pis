# Integration: keep the workflow manifest in step with the merged P07

## Why

W2 added two P07 statements while it worked on its own branch: the subject profile declared before candidate work, and the per-task search budget.
W5, on a separate branch, rewrote `workflow/v1.0/文件清单.md` and `提示词全集.md` and added `test/workflow-manifest.test.ts`, which checks that both match the runtime prompts byte for byte.
Neither branch could see the other, so after the merge the manifest still recorded the older P07, and both manifest tests failed.

## Change

- `提示词全集.md` now quotes the merged P07 verbatim. The previous P07 text occurred exactly once and was replaced in place.
- `文件清单.md`: recomputed the size and SHA-256 of the P07 row and of the `提示词全集.md` row itself.
- No prompt text was edited.

## Verification

- `node --test test/workflow-manifest.test.ts`: 2 of 2 tests pass.
- The full suite was rerun after this commit, together with the rest of the integration checks.
