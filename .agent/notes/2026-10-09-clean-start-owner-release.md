# Clean initial mission owner handoff

The explicit CLI `mission start` command now publishes a private clean-start release receipt after its initial contract and checkpoint are committed. The receipt binds the A001 source, contract digest, and first checkpoint digest. Publication uses the mission writer lock. A released A001 cannot mutate or enter the assessor through its old facade.

A subsequent invocation may create A002 from that receipt only when the initial checkpoint remains canonical, the mission has no operation or final files, no mission-local assessment or dispatch artifacts, no mission-bound stage work, and the new owner is on the same host and boot. Without that release, existing process identity and unknown-effect rules remain in force. Existing pre-change missions are not relabeled or migrated.

Offline checks: TypeScript typecheck and the local mission host and CLI tests passed. The CLI regression uses separate processes and a fake runner. It does not call a real model or external service.
