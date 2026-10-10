# Offline test commands (2026-10-09)

Local workflow repair testing uncovered that plain npm scripts can start npm's
update notifier and request registry access. The project working rules now
document direct installed TypeScript and Node test commands, plus npm's offline
flags when an npm script is necessary. This is execution guidance only; it
does not add a release gate or change any runtime workflow rule.

The combined local repair tree was typechecked with the installed TypeScript
binary and exercised with direct Node test commands without a model or network
call. Final exact-tree test results are recorded in the acceptance manifest.
