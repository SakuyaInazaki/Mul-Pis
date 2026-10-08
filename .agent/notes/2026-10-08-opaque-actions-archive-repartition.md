# Opaque Actions archive repartition

This batch adds a separate, push-triggered transport recovery route for one existing encrypted Actions result archive. The request records only public workflow and artifact identity, archive length, and SHA-256. The route does not decrypt or inspect ZIP members, start research, contact a model or provider, or create credentials.

The dedicated workflow requires the fixed repository, actor, branch, first run attempt, and commit message. Its local Node action uses the job's existing read-scoped GitHub token to verify the exact completed, cancelled source workflow and its artifact metadata. It downloads the archive through a restricted HTTPS redirect, verifies the complete original bytes against the request, and uploads immutable 16 MiB opaque parts. A small index is uploaded last, binding the original archive length and SHA-256 to every part's byte digest and returned artifact identity. Missing or ambiguous part or index receipts fail the route. The token is not forwarded to the artifact storage redirect, and no archive bytes are printed to logs.

The root request file pins the reviewed source workflow's control HEAD, artifact ID, archive length, and archive SHA-256. The original archive remains unchanged in its original workflow run. The new transport artifacts have one-day retention and require the final index before reconstruction can be trusted.

Local verification covers exact source identity, redirect restrictions, byte-count and SHA mismatches, part upload interruption, final index receipt failure, reordered index keys, and reconstruction integrity. The actual GitHub download and upload will be established by the separately authorized workflow run.
