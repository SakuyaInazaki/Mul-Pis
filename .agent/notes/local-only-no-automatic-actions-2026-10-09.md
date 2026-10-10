# Local-only execution and disabled automatic Actions triggers

The owner requested that development and tests use the current workspace, with no independent quota-consuming cloud tasks and no GitHub CI execution.

This change removes push triggers from the regression workflow and the two historical request-branch workflows. Definitions remain available for history, but this work will not dispatch them. The balance workflow retains its former push-only job guard and therefore does not execute on its remaining manual event.

Subsequent source and note publication must not launch Actions. Test results are obtained in the current workspace; a GitHub check is not a publication or research-completion gate. Existing workflow code, model behavior, and task acceptance requirements are unchanged.

The triggering configuration was inspected on the repair branch. The separate manual-only smoke workflow already had no automatic event. This change does not assert cancellation of any previously admitted run or modify other branches.

The local campaign test now checks the manual-only event directly. Its earlier assertion still expected a push event after this configuration changed; the correction preserves the existing signed-ledger and admission checks.
