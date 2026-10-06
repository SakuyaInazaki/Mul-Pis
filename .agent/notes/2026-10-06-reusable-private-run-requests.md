# Separate reusable private run requests from code publication

The private Actions workflow now listens for push requests only on a dedicated control ref, in addition to its existing explicit dispatch route. Each request uses one stable, exact commit message and a unique commit SHA. The requested tree must match the tested feature tip and be empty relative to its first parent; an optional second parent preserves fast-forward control history across source changes. A pre-decode check requires successful offline CI for the source commit. The host independently checks request identity and idempotency, while continuing to authenticate the old signed mission seed and encrypted carry. Feature-branch code pushes cannot start the paid job.

An offline descriptor helper prints the tree and parent list without creating a commit or contacting GitHub. The source-specific restart review adds an exact host-effect classification for the previously completed, settled provider-length response. It preserves inherited unknown effects and historical fee holds; it does not mark an incomplete research task or scientific claim as accepted.

No API key, private research input, actual private fee amount, new permission or new secret was added to source. This change batch did not push, dispatch or start a paid run. Typecheck and focused synthetic tests passed before full repository integration.
