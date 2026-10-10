# Bounded provider HTTP reason classification

The host transport probe now records one bounded reason class for failed provider responses: `context-window`, `input-schema`, `tool-reasoning`, or `unknown`. It retains the existing allowlisted code and type fields, discards raw provider error messages, and passes the original response bytes unchanged to the SDK. A bare HTTP 400 or generic `invalid_request_error` remains `unknown`; it does not establish context exhaustion.

The class is based on a known machine code, or the one complete reasoning-content error sentence documented by DeepSeek. Earlier encrypted v1 transport census rows without the new field remain valid, and new rows may carry the enum field without changing the signed accounting or unresolved billing treatment. A no-goal assessment's optional host-authored pending action is preserved during ledger recomputation.

Sources: https://api-docs.deepseek.com/quick_start/error_codes/ ; https://api-docs.deepseek.com/guides/responses_api/ ; https://api-docs.deepseek.com/guides/thinking_mode/ ; https://api-docs.deepseek.com/quick_start/agent_integrations/copilot_cli/ . The documentation lists multiple HTTP 400 causes, so status alone is not used as a specific reason.

Verification uses offline synthetic responses and ledger carries only. No provider requests were made.
