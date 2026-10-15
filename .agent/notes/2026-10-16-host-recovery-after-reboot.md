# Host recovery after system reboot

A real continuation attempt failed at session startup because the host had rebooted. The process identity probe correctly classified the former boot's process as dead, but the M07 recovery controller additionally required both boot identities to be equal. This made a persisted goal impossible to resume after a normal same-machine reboot.

Remove the redundant same-boot requirement from fresh-attempt recovery. Keep the verified fresh process identity, same host, dead prior process, unchanged goal/policy/knowledge, unique attempt claim, and external-operation reconciliation checks. Recovery neither resumes an old model session nor repeats unknown submissions.

Extend the existing recovery-and-baseline test to exercise a new boot while retaining explicit rejection of alive, unknown and other-host owners. All repair edits are completed before running the focused recovery checks and typecheck together. Real continuation then supplies the acceptance evidence.
