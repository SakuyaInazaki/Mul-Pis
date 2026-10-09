# Published knowledge revision handoff

The default local mission assessor handoff previously required every record in a committed M04 intent to appear at the same version in the final snapshot. A proposal can validly revise one record twice: the intermediate version remains part of the authenticated proposal history, while the snapshot points to the final version. This caused a pre-assessment failure after a published merge.

The handoff now checks the source proposal and committed result, starts from the frozen base snapshot, verifies each changed record in order with a contiguous version and `supersedes` link, compares its stored source bytes to the committed intent, and requires the final snapshot to match the latest version of every record. The assessor pack and index still include every changed version and its current limits.

A synthetic default mission regression covers sequential revisions, rejected-task feedback, required assessor reads, a fresh-process retry after a no-issued failure, and the next bounded dispatch. Missing, reordered, and changed intermediate history are rejected before assessor entry. The tests use a fake runner and make no model or network calls.
