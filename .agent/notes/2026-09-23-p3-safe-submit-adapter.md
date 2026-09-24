# P3 private submit adapter (2026-09-23)

This batch added a local-only host wrapper beside the read-only P3 result verifier under `.agent/private/p3-workflow-adapter/`. It does not modify P3 or the turnstile pool, and it did not make a real platform or model request.

`safe_submit.py` supports one `submit` or `custom-test` action per unique run/attempt. It freezes the exact `.cu` file text before calling the existing P3 Web method, creates a mode-0600 attempt claim first, discards all stdout/stderr from Web construction and the call (including fd writes), and never retries an unknown result. A returned submission ID produces a mode-0600 receipt with the exact submitted text for `verify_result.py`; only safe ID/status fields are printed. Custom-test uses the existing contest route and emits no raw API body. M07 new artifacts are accepted only through an explicit matching run/task `work` directory, verified by realpath; older P3 `.cu` candidates may be read directly.

Offline mock tests cover a successful receipt, single-use attempt, failure without retry, custom-test routing, Python/fd output suppression, matching M07 work directory, and symlink escape. The wrapper and verifier tests passed 9/9. No submission, custom test, model call, credential read, commit, or push was performed in this batch.
