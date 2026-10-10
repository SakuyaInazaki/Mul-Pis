# Canonical grounded next task

The live assessor response previously duplicated the bounded task's objective between a top-level object and a grounded object. A model reply containing the objective in the grounded object could be rejected as an unknown field and incorrectly described as having an unavailable scope or missing hypothesis. Repeated repair then addressed the wrong cause.

For new grounded assessments, the single model-authored task now includes objective, original obligation IDs, open issue IDs, registered scope, hypothesis, expected evidence and line-addressed citations. The host validates those fields and derives the full executable top-level task. An optional top-level legacy mirror is accepted only if its supplied objective, obligation IDs and scope agree exactly. Ungrounded live assessments keep their earlier response shape. Authenticated historical assessments are read as carried records and do not need the newly required field.

Grounded task validation now reports a static nested field path and reason for an unsupported key, empty objective or hypothesis, invalid ID list, unavailable scope, or missing expected evidence. Feedback does not echo model-authored field values. The existing original-goal, complete current-session evidence read, selected-result, capability and fresh-only effect checks remain binding. A structurally corrected response alone does not establish scientific quality or mission completion.

Offline synthetic tests cover a canonical task, matching and conflicting legacy mirrors, field-specific repair feedback, and historical carry readability. No private task output is included.
