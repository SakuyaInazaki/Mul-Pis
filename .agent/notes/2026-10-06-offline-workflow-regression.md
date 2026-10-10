# Independent offline workflow regression

The workflow-policy repair now has a separate code-only Actions check. Pushes to the project branches run typechecking, the Node regression suite, synthetic encrypted-transport tests, and synthetic browser step/capture tests with pinned dependencies. No model credential or confidential-input secret is injected, no private campaign driver is invoked, and no repository-chosen job deadline is added. GitHub's own runner limits still apply.

This check is independent of the private campaign workflow and its one-use paid-run trigger. It can verify a published repair without consuming model budget or copying experiment material. Passing it establishes engineering regressions only, not a new scientific result or real-browser integration.
