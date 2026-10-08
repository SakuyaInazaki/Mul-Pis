# Local mission observation and current-validity follow-up

The default host now checks selected candidate, evaluator receipt, host observation and M04 evidence when a recorded fulfilled mission is read. A failed current check raises an explicit recorded-versus-current error; it does not rewrite the historical checkpoint.

Trusted evaluators receive frozen original input identities and host capability facts during preflight. Evaluation gets a new private output directory. The host admits only declared UTF-8 text or JSON observation files, requires an exact member set, freezes each bounded file, and records byte hashes and mission/run/task/evaluator/candidate bindings. M07 review, fresh M04 full-text coverage, selection and restart validate those files. Negative evaluator checks retain their actual observation evidence without selection.

Offline tests exercise post-completion corruption in fresh processes, observation member and binding failures, unsupported types, stale candidate bytes, and production CLI start/run/resume with an explicitly trusted Node preloader and synthetic non-CSR observation. No private lab algorithm, scientific result, model call or network request was part of this batch.

The worktree uses a temporary `node_modules` symbolic link pointing to the sibling dependency directory for local tests. After all testing, remove only this link; its target is recoverable and must remain intact.
