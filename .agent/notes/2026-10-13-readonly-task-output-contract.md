# Match read-only task declarations to their output capability

A reason-mode task could declare required work-directory output files even though its session only receives read tools. The session returned analysis, but the subsequent review rejected its missing files. Check mode already rejected this impossible contract before dispatch.

Apply the existing check-mode declaration rule to both read-only modes. Reason and check use an empty expectedOutputs array; the controller continues to save their returned text as reportPath for ordinary review. The Pi tool guidance now states this directly. Execute retains file creation and its existing output checks. No task permissions, goal criteria, historical records or running sessions are changed.

The regression first reproduced the missing reason-mode rejection. It now verifies that invalid declarations create neither a model session nor a task, and that valid read-only tasks retain their automatic report and can be reviewed. Two existing review fixtures were aligned with their intended output capability.

Validation: M07 tests passed 44/44, TypeScript typecheck passed, and the full offline suite passed 1,593 of 1,609 tests with zero failures and 16 existing platform/local-fixture skips. No real model or network was used by the tests.
