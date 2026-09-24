# Recovery release review

This change batch publishes the recovery control, knowledge merge recovery, M07 attempt, and workflow evidence handoff changes after a staged-file review and offline checks. The review record stays local and must not be staged.

Before removing any tracked file from the public tree: the exact target is `.agent/notes/2026-09-21-workflow-self-issues.md`. Current push policy permits only `.agent/notes/.gitignore` in the public tree. Remove this target from the Git index with `git rm --cached` while retaining the local file. It remains recoverable from the local working tree and existing Git history. This action does not erase earlier public history.

Initial review: local HEAD and remote main matched before staging. The simulated indexed public tree had 176 files, no forbidden paths or nested `.git` entries, and only `.agent/notes/.gitignore` under notes. Typecheck, 313 offline tests, and staged whitespace check passed. A newly added observer test referenced a local-only private script; publication is held until that test is made self-contained and final checks are repeated.
