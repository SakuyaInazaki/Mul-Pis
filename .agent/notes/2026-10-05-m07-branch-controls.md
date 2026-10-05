# M07 branch controls in CLI and Pi extension

## Change

- Exposed an exact same-goal fork reference in the existing M07 delegate tool and a reviewed candidate selection action in the existing goal tool. The CLI now accepts a strictly validated task JSON for goal delegation and an explicit select-branch command. Omitting the selected task records an explicit no-selection decision. Neither route implements its own branch policy or summarizes a session into a fake fork.
- The Pi service sends selection through the M07 controller's mutation path. Its progress runner now forwards actual checkpoint and fork operations to the underlying runner; without those methods, a successful execute task could not provide a branch checkpoint through the extension.
- Goal status and selection responses expose allowlisted task/status identifiers, counts and a branch-unavailable boolean. They omit raw failures, unavailability reasons, selection rationale, transcript, session metadata, tool arguments and report paths; full private control records remain available to the controller.

## Verification

- Offline CLI and Pi extension tests exercise actual controller delegation, checkpoint, a persisted true-fork lineage receipt, review, accepted selection and explicit no-selection. Invalid references and malformed action fields fail before dispatch; duplicate selection fails at the controller. Focused CLI and extension tests passed, 23/23. TypeScript typecheck passed.
- No paid model call, network request, commit, push, or publication was performed for this batch.
