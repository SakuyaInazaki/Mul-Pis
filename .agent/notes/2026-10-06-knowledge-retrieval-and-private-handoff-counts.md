# Knowledge retrieval and private M04 handoff count barriers

Date: 2026-10-06

The retrieval ranking previously ignored text after 24,000 characters or 96 distinct terms, so a relevant record could become invisible without an omission notice. Ranking now uses the full request text while the resulting knowledge pack remains bounded by its explicit character and record limits. Historical premise and warning closure no longer stops at 2,000 published versions; missing versions, cycles and pack limits still fail or report incomplete explicitly.

The private M04-to-M07 handoff previously dropped adopted experience refs after 24 in the campaign driver and rejected more than 24 eligible refs or 48 source/dependency records in the export. These count ceilings were removed. The fixed private knowledge export byte bound, archive manifest byte bound, source identity and applicability checks, live-limit checks, unsafe-content rejection and dependency-cycle rejection remain. The writer now checks the manifest byte bound before replacing a separately stored knowledge payload, avoiding a write/load mismatch for large valid ref lists.

Synthetic tests cover a tail ranking term, more than 96 distinct query terms, a warning beyond 2,000 tiny historical versions, and 49 adopted source records with 49 pinned dependency records surviving export and load. Focused tests pass. The final repository-wide typecheck awaits completion of concurrent ledger edits. No real model, network, private campaign or publication was run.
