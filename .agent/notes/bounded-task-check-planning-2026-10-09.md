# Bounded task check planning feedback

A default local mission assessment can name a subset of unresolved original obligation IDs in its next task. The local M07 adapter turns each selected obligation's full description into a mandatory task check. The previous assessment instructions warned against claiming global optimality from finite tests, but did not explain that selecting a broad original obligation makes it a task-level pass condition. A bounded candidate could therefore pass local correctness and measurement while its task was rejected because an open-ended check remained unrun.

The assessor schema guidance now states this mapping and permits a strict subset. It asks the model to select only obligations that the bounded task could pass, retain broader original obligations as unresolved, and inspect prior rejected-task dispositions. This is planning feedback, not an acceptance gate: the assessor still authors the task, the evaluator still reports every original obligation, and M07 still requires every authored task check to pass.

A fake-runner default mission regression covers a bounded task check passing while a separate broad original obligation remains unknown and the original objective remains incomplete. No model or network request is made by the test.
