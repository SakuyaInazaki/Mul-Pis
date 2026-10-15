# Native RPC steering for controlled runs

A private launcher using Pi `--print --mode json` with stdin ignored could not deliver later user messages to its active main session. A tool-result field remains untrusted task data and does not substitute for a user message.

Pi 0.85.1 RPC mode accepts LF-delimited JSON commands on stdin, including a `prompt` with `streamingBehavior:"steer"` while the agent is running. The launcher gained an opt-in `--rpc` mode. It reads the existing initial prompt file and writes it as the first native RPC prompt. A private FIFO becomes the child's stdin; opening it before spawn keeps stdin available for later writes. The default print/json launch path remains.

The research extension's existing noninteractive and continuous predicates include RPC so the same recovery handshake, bound-goal controls, tool loadout, automatic continuation and shutdown checkpoint apply. No third-party Pi source or active process was changed. A sender must verify the saved process identity, send native JSONL, and check the matching RPC response. An accepted or queued prompt is not proof that the requested work completed. Unknown external actions still require reconciliation before recovery.

Focused offline continuation and extension tests, TypeScript typecheck, launcher syntax check and a local FIFO smoke test passed. No network, model call or live experiment was used in that verification. The active print-mode process was not restarted merely to activate RPC.
