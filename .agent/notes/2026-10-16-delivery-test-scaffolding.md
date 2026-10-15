# Delivery test scaffolding cleanup

The user requested continued removal of redundant tests and unused test machinery. Before deletion, this batch records the exact targets:

- In `test/stage-cli.test.ts`, remove `CLI M09 reaches the real stage and fails closed on the generic fake report`. It constructs an entire synthetic M08/M04 archive merely to show that the default fake runner does not emit the M09 response schema. The retained `test/m09.test.ts` exercises actual delivery copying, independent checking, exact M08/M04 pairing and current knowledge state. The retained CLI M08 case exercises the common CLI configuration/JSON/stage dispatch path. Remove the now-unused Workspace import, and register cleanup of the retained CLI test's temporary workspace.
- In `test/m09.test.ts`, all three retained cases call `fixture(t)` with no settings. Remove the unused `settings` argument and its ten switches for synthetic limits, commands, broken reports, read omissions, partial status and checker callbacks. Likewise simplify `gate` to its actual default response. Keep the three existing test behaviors and their output/read assertions unchanged.

All removed code is tracked in Git and recoverable from HEAD or the working diff. Restore individual blocks to preserve earlier authorized changes. These initial targets change only tests; unified validation follows completion of all source and test edits.

Source cleanup identified alongside the obsolete observer test: delete `src/runtime/bounded-file-tail.ts`. A repository-wide tracked-code reference search finds no import, re-export or caller after the unused observer test is removed. The actual private campaign observer uses its own live observation path. This unused synchronous helper and its interface are recoverable from Git HEAD; no running workflow calls them.
