# Controller-owned context boundaries for stage sessions

## Change

- Added a typed, controller-owned boundary request and dispatcher for fresh, continued, and true-fork sessions. Intent (`new-work`, `independent-judgment`, `causal-continuation`, or `branch-exploration`) is checked against the requested history mode independent of actor role. The receipt records why a history relationship is appropriate, what inputs are linked or frozen, the model and actor role, and the separately granted tool capability (kind, root and names where applicable). A linked file or index is expressly not evidence that the model read it.
- Routed M01–M06 and M08–M09 session openings through the dispatcher, rather than leaving the policy as a configuration value unused by actual execution. Kept the workflow's deliberate fresh reviewer/checker sessions, M03 original actor and same-reviewer continuations, and M04 first-round optional M01 continuation. M07/M08 feedback still forces a fresh M04 research session.
- Continued sessions check the persisted spec's role, model, and tool grant before resuming, then require the exact same session ID/file/spec to return. Fork requests require a frozen checkpoint, frozen evidence bindings and (for writable task roots) a controller-frozen workspace authority; they initially reject cross-model history transfer until compatibility is demonstrated. The dispatcher requires an attested frozen-leaf runner capability and a committed child lineage receipt tied to the exact checkpoint, leaf, child and evidence before returning a promptable handle.
- Each opening awaits a serialized durable run receipt before a provider prompt may start. If persistence fails, the handle is disposed and the stage cannot prompt. The receipt reads the effective persisted spec, so an audited private campaign wrapper that substitutes confined custom tools records that actual grant rather than falsely reporting its requested native execution grant.
- A requested execution grant transformed into custom tools is accepted only when the live runner attests the exact handle's factory-backed confined grant, its persisted authority agrees, the canonical root is the controller-requested task root and writable filenames are bounded relative paths. The receipt records the actual root and write allowlist; an arbitrary wrapper with the same custom tool names or forged persisted authority cannot present itself as an audited narrowing. `ProgressRunner` forwards this live attestation without changing the handle identity.
- Extended stage-run session records with an optional boundary receipt. Old run records remain readable; absence of the receipt does not imply a fork or any new guarantee.

## Review and verification

- New focused tests check real dispatcher routing with the fake runner, persisted reasons, rejection of a silent grant change, exact resume identity, failure before prompt on receipt-write failure, fake fresh sessions masquerading as forks, fake execution-to-custom wrappers with forged metadata, and rejection of mutable evidence or model changes for a fork.
- Focused stage, M04 checkpoint, M08, M09 and boundary tests passed: 50/50. The concurrently edited M07 controller was still mid-implementation when typecheck was attempted, so final aggregate typecheck and full suite belong to the integrated tree.
- This batch does not claim that a saved path means a file was read, that Pi compaction preserves all content in model context, that cwd limits OS-level access, or that model-scored scientific quality is proved.

## Publication scope

No private research materials, account tokens, model outputs, or upstream source bytes were added. This note describes mechanisms and test status only.
