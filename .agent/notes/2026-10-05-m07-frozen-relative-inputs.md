# M07 frozen relative input identity

## Change

- A same-goal fork retains the parent's exact declared input names and compares each through the parent's validated canonical source and frozen work copy. The fork copies the frozen bytes; it does not reread a changed live input.
- Plan and versioned resource references are normalized through that same frozen mapping before comparing obligations. Different input order, plan identity, resource identity or resource version still fails closed.
- The generic candidate-lesson prompt distinguishes an in-task proposal from amendment or contradiction of an existing pinned knowledge record. The latter actions explicitly require priorRef with storeId, recordId and version.

## Verification

- A focused offline test uses two relative inputs, a plan and a versioned resource, changes the live source after the parent checkpoint, and confirms the child retains the frozen bytes and canonical references. Negative mapping tests pass. M07, CLI and Pi-extension adjacent tests passed 89/89; TypeScript typecheck passed.
- No model call, private task content or credential was included in this change batch.
