# M07 returned artifact paths, 2026-10-12

A live main research session received a compact `research_delegate` result with only task identity and status. An earlier in-flight steer was then visible before the agent had read the returned task's report and actual output, and it delegated again without using the latest result.

This batch restores only the returned task's existing `workDir`, `reportPath`, and `expectedOutputPaths` in the direct tool summary. The tool guideline asks the main session to read the final report and relevant actual outputs before planning another delegation; an earlier running notification is not the final result. No report or session body is copied into the tool response. Goal status remains compact, and no controller gate, schema, or synchronous push is added.

The existing real same-goal fork test read the paths from delegated tasks' compact results, opened the actual reports and outputs, and confirmed that the compact responses omitted session and tool-log data. `node --test test/pi-extension.test.ts` passed 19/19; TypeScript typecheck and `git diff --check` also passed. This verifies path discoverability and the absence of a direct dump, not the model's scientific judgment or compliance with the guideline. The active main process was not restarted by this source change.
