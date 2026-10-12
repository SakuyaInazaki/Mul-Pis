# M04 compact tool result identity (2026-10-12)

`runM04` already returns the submitted proposal ID and published snapshot ID. The Pi extension's generic compact stage result omitted both, even when it preserved paths to the authoritative proposal and merge files. A main research turn therefore had to infer the merge identity from prose remarks or open a file before it could name the exact proposal and snapshot.

Pass these two existing fields through only for M04. Keep the current artifact paths and all other stage summaries as they are. This change does not decide any record's scientific status, modify a knowledge record, or reinterpret an active task. The prior implementation remains recoverable in Git.
