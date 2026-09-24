# Remove project per-request token quotas

The user rejected retaining separately configured input and output token quotas for each H/I request. Earlier values of 20,000 input and 2,048 output were examples without a measured H/I workload basis.

Changes in this batch:

- Removed `perPromptMaxInputTokens` and `perPromptMaxOutputTokens` from the research campaign plan. Old plans with these fields fail validation with an explicit migration message.
- Prepared requests reserve conservative input from the assembled prompt and check it against the remaining campaign and phase input budgets. There is no separate fixed per-request input quota.
- Research requests keep one provider call, no retries, no tools, and payload verification, while leaving output length to the Pi SDK and provider model limits. Removed the separate 16,000-character reply gate.
- The research budget ledger now supports observed-output requests: it counts the call and reserves the actual prepared input before dispatch, then charges reported output and SDK-estimated cost after the reply. An overrun is recorded as `exceeded` and prevents further requests or automatic promotion. A final request can exceed the declared aggregate output or cost budget; those aggregate ceilings are now post-response stop conditions for this path, not hard maximum spend guarantees.
- Protected phase preflight still checks the maximum call count and disjoint phase ceilings. It cannot guarantee that every G request fits token or cost ceilings without a per-request cap; insufficient remaining budget yields an inconclusive experiment.
- Updated the RSI plan example and tests. No model or network calls were used for verification.

Validation: `npm run typecheck`, full `npm test` (272 passing), and `git diff --check`.
