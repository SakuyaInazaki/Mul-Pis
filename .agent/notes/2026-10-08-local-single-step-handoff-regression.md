# Local mission single-step continuation regression

The existing `mission resume` command executes one original-objective step. This batch adds an offline production-CLI regression showing that two separate local processes each dispatch one distinct M07 task and settle its M04 feedback, while the first task bytes remain unchanged. A later host-recorded unknown effect prevents any additional assessor or M07 dispatch.

This test supports host-controlled continuation between settled steps. It adds no new pause signal, task limit, timer, scientific selection rule, or production execution behavior. Synthetic fixtures use the trusted fake runner and contain no research input or account material.
