# M07 lesson evidence count repair

M07 review and the private archive validator both imposed a fixed count ceiling on lesson evidence paths. A valid lesson could pass the substantive review and file-byte checks yet fail solely because it cited more paths than that ceiling. Removed the two count checks from `src/m07/controller.ts` and `src/workflow-archive/m07-private.ts`.

The lesson file byte limit, JSON and schema validation, safe relative paths, realpath containment, evidence file existence and type checks, and the archive's total byte bound remain. The original task and its evidence were not edited by this source repair.

An offline integration case uses multiple distinct small evidence files and exercises delegation, review, archiving and archive reload. Existing invalid-path and oversized-file cases remain. Focused offline tests and TypeScript typecheck passed. These checks establish the repaired validation path; they do not establish a live experiment outcome.
