# Contained historical versions during recovery

A terminal campaign stopped during authenticated history recovery before starting model work. Its current carry already held an older same-task version and the current version. An earlier carry held only the current version. The recovery merge looked for overlap only at the end of the earlier timeline and the start of the current timeline; it prepended a duplicate version and reported a version-order conflict. This was a reconciliation error, not evidence of changed historical bytes.

Recovery now recognizes an earlier timeline whose exact snapshots already occur in order within the authenticated current timeline. It retains the current entry byte for byte, including older superseded versions and the current top-level files. Existing identity, archive, core-file, timeline progression, and divergent-version checks still run before this shortcut. Conflicting order and source bytes remain integrity failures.

Synthetic tests cover contained suffix, interior, and sparse timelines; a full multi-ancestor walk with a newer unrelated task; reversed chronology; and differing candidate bytes. This change grants no selection or scientific authority to superseded history and does not change request accounting or unknown effects.
