# Publication documentation alignment

Corrected implementation guidance to match the current continuation and execution-loop code. Repeated unchanged turns now produce diagnostic feedback and another action prompt; they do not stop a bound active goal by count alone. New execute delegations under a continuous goal use the existing until-ready review loop, while legacy round and deadline fields remain readable for audit without controlling current execution. The documentation index now distinguishes local real-model stage runs from an unverified complete M01–M09 run or general research benefit.

Limited the repository's publication instructions to the authorization for each release. A historical authorization for original evidence remains documented as history; it does not authorize original private run material in the current general source, test, and documentation release. Existing credential exclusions, reviewed archive handling when separately authorized, and explicit staging checks remain.

Before editing, exact original bytes of the six changed documentation files were copied to a local private archive with a path-and-reason manifest. The originals remain recoverable from that archive and Git history. This batch changes documentation and release instructions only; it does not alter code, tests, research records, or running processes.

Validation: reviewed the targeted diff, checked for remaining stale no-progress and fixed-round descriptions in the edited sections, and ran `git diff --check`.
