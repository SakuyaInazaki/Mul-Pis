# Recovery session-start failure closes the Pi tool gate

## Problem and impact

Pi records an exception from the extension's `session_start` handler and then continues with the initial prompt. A failed M07 host recovery therefore left a live, unbound Pi process that could still call ordinary tools. The controller did not accept a new attempt, so that process had no authority to continue the goal.

## Change

- The research extension now records a failed recovery initialization, clears its goal binding and active tool list, and keeps the original error visible to Pi.
- On the following `before_agent_start`, it requests abort and shutdown. Its `tool_call` handler blocks every tool with termination requested while the failure state remains set. Successful initialization clears the failure state. Normal sessions retain their existing behavior.
- A focused extension test simulates a rejected recovery and checks prompt shutdown plus rejection of a read tool, a research tool and a shell tool.

## Recovery and verification

This is a source change; reverting the extension and test restores the previous behavior. The existing stopped, unbound process is not resumed by this change. Tests were not run in this batch because the main agent is coordinating validation.
