# Original project evidence release (2026-09-24)

The user explicitly requested publication of original project notes, run logs, associated workspace records, and supplied attachments. These archives preserve the selected source files byte-for-byte, under their source-relative paths. Each archive was reopened and every decompressed member was compared with its source bytes. No hash manifest or edited substitute is used. The 79 original project change notes are published separately in `.agent/notes/`.

| Source | Archive | Original files | Original bytes | Archive bytes |
| --- | --- | ---: | ---: | ---: |
| Local runtime and related records | `private-runtime.tar.gz` | 1,701 | 147,039,810 | 15,210,407 |
| Research workspaces and stage records | `workspace-runs.tar.gz` | 10,505 | 269,372,050 | 62,269,585 |
| Telemetry | `telemetry.tar.gz` | 22 | 6,639 | 2,651 |
| Existing resource attachments | `resources.tar.gz` | 2 | 7,794,789 | 7,170,700 |
| Seven user-supplied recovery attachments | `user-recovery-attachments.tar.gz` | 7 | 66,056 | 27,790 |

Eight account authentication files or copies containing actual account API keys were excluded: four standalone local runtime `auth.json` files, one workspace `auth.json`, two account key JSON files, and one old launch script containing an account key. All remain local. Ninety-two duplicate publication backups or generated summaries were excluded because the original notes are published separately. No source file was changed or removed for this release. Dependencies, third-party checkouts, symlinks, and nested Git directories were not archived.

Submission `progressSubscriptionKey` values were retained in the original workspace records. The local frontend uses them for read-only progress subscriptions; that observation does not prove the server's full permission scope. Account API keys and authorization files were checked separately and excluded.
