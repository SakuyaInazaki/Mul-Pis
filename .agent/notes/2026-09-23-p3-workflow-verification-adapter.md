# 2026-09-23 P3 workflow verification adapter

Private infrastructure note; this batch contains no candidate algorithm, submission, or model call.

- Read the P3 project entry instructions and its existing normal HTTP read-only detail/scoreboard client interfaces. The documented submission detail has status and raw score; the personal P3 scoreboard row has net score and attributed submission ID. Source text may be absent from detail.
- Added the ignored `.agent/private/p3-workflow-adapter/verify_result.py`. It takes a SID, current code file, run ID, and a controller-captured submission-request receipt. In live mode it calls only read-only detail and personal scoreboard endpoints through the existing client. Offline mode takes saved response fixtures. It requires platform Accepted, raw at least 82.33, P3 scoreboard net at least 72.33 attributed to the same SID, and exact submitted-source text match. If the platform returns source, it compares that full text too. Missing or inconsistent receipt, source, attribution, or terminal platform data yields inconclusive or not-achieved, never a success based on local estimates.
- The receipt contract is `{version:1,source:"controller-submit-request",runId,sid,submittedAt,submittedCode}`. It must be written by the trusted submit controller from the exact string passed to the existing submit call; a candidate file path or model statement is not sufficient. The verifier never prints source, credentials, or raw API responses.
- Offline tests in the same ignored directory passed 3/3. The adapter was not run against the platform, did not access credentials, and did not submit.

Boundary: when the platform omits source, code-to-SID identity rests on the trusted local submit-request receipt plus live platform SID/score checks; it is not an independently retrieved platform source attestation. This adapter checks a frozen task outcome, not M07 scientific validity or L5/RSI improvement.
