# Explicit stop in reviewed mission test fixtures

The V5 and V6 reviewed-mission regression fixtures now return four deliberately malformed assessor replies and then raise a synthetic `AbortError`. This bounds each offline test independently of any production repeated-error limit while retaining the reviewed-successor, fresh-assessment, and no-replay assertions.

Verified with the direct local reconcile test file (97 passed) and the direct TypeScript no-emit check. No models or network services were used.
