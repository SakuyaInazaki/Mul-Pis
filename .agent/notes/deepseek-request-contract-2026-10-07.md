# DeepSeek request contract preflight

Added a project-owned, read-only validator for the final serialized DeepSeek Chat Completions request. No third-party SDK source was modified.

The validator rejects duplicate call IDs, orphan or duplicate results, incomplete tool-result groups, forced tool choice in thinking mode, and missing reasoning fields. Optional original Pi message metadata checks reject unsigned thinking or reasoning lost by serialization. Valid reasoning is preserved without substitution. Assistant content:null remains allowed because the official Chat schema permits it; the conflicting integration-guide advice is not treated as a proven cause of historical HTTP 400s.

The Pi adapter now runs this validator on final serialized bytes before request reservation and transport. A rejection retains only a static category and numeric message index. A whole-prompt not-issued proof is minted only when the exact prompt lease contains zero provider requests; a later rejected payload cannot erase an earlier issued request. M07 records the host proof, and the private archive validates its static receipt. No payloads, tool IDs, scientific content, credentials or reasoning text enter that receipt.

Validation: dedicated validator tests and integrated offline Pi/M07 tests passed. They cover valid unchanged history, reordered parallel results, bad call/result graphs, thinking tool choice, reasoning provenance, a first unsent request, and a later rejection after an unreceived request. No real model or network requests were made by these tests. No commit or push was performed.

Official references:
- https://api-docs.deepseek.com/api/create-chat-completion/
- https://api-docs.deepseek.com/guides/thinking_mode/
- https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi/
