# Remove the consumed private-campaign push trigger

The one-use paid `push` trigger in `.github/workflows/manual-private-campaign.yml` was removed after its intended recovery launch. The private campaign now has only `workflow_dispatch`, with the existing required `authorize_bounded_run` input and repository, actor, branch, and first-attempt checks. The encrypted input, ciphertext-only outcome, encrypted continuation, and existing secrets remain unchanged. A push still runs the separate code-only regression workflow; it cannot launch this private campaign.

Offline workflow tests now assert that `workflow_dispatch` is the only declared trigger and that the job has no push/commit-message admission branch. This change did not initiate a paid run or publish private material.
