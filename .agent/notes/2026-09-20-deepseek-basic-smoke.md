# DeepSeek V4.1 Flash basic smoke test

Date: 2026-09-20

## Scope and configuration

- This was a bounded connectivity and Pi-session smoke test. It did not run a research topic or any M01–M09 workflow stage.
- The user selected DeepSeek V4.1 Flash. The API model identifier confirmed by the official model endpoint and local Pi 0.85.1 catalog is `deepseek-flash`; the harness model reference is `deepseek/deepseek-flash:low`.
- Credentials are stored only in the ignored `.agent/private/deepseek/credentials.json`. The directory mode is `0700` and credential/config file modes are `0600`.
- The completed test injected an isolated Pi `ModelRuntime` with private model configuration; it did not read or change the user's global Pi profile. The retained manual script now exercises Pi's default runtime-discovery path through `PI_CODING_AGENT_DIR`, matching the reusable launcher.
- The manual smoke-only profile under `.agent/private/deepseek/smoke-profile/` caps output at 768 tokens. The reusable launcher uses the parent private profile without that override, so later research runs retain the model's normal output capacity. The launcher sets `PI_CODING_AGENT_DIR` before starting Pi or the harness and passes the key only in the child environment.

Official references:

- DeepSeek Pi integration: <https://api-docs.deepseek.com/quick_start/agent_integrations/pi_mono/>
- DeepSeek API quick start and base URL: <https://api-docs.deepseek.com/>
- DeepSeek thinking mode: <https://api-docs.deepseek.com/guides/thinking_mode/>

The repository-local Pi 0.85.1 catalog additionally records `deepseek-flash` as DeepSeek V4.1 Flash with text and image inputs, the OpenAI-compatible chat-completions API, DeepSeek thinking format, and assistant reasoning-content replay required for multi-turn/tool requests.

## Exact observed results

The manual script `scripts/manual-deepseek-smoke.ts` completed successfully:

- `GET https://api.deepseek.com/models`: HTTP 200; returned `deepseek-flash` and `deepseek-v4-pro`.
- Initial streamed text turn: exact visible response `STREAM_OK`; 117 input tokens, 49 output tokens, reported cost USD 0.0000939.
- Persisted-session resume: recovered nonce as exact visible response `ORCHID-731`; 141 input tokens, 30 output tokens, reported cost USD 0.0000783. The Pi session ID remained stable and both JSONL and spec paths were present.
- Fresh-session isolation: exact visible response `NO`; 118 input tokens, 90 output tokens, reported cost USD 0.0001434.
- Custom tool and result continuation: one successful `smoke_echo` call followed by exact visible response `TOOL:PEAR-42`; 207 input tokens, 24 output tokens, reported cost USD 0.000092436.
- Read-only real-file tool: one `material_read` call, coverage exactly `probe.txt`, and exact visible response `CEDAR-908`; 182 input tokens, 5 output tokens, reported cost USD 0.000063672.

The five final assistant messages reported 765 input tokens and 198 output tokens. Their summed SDK `usage.cost` fields were USD 0.000471708. This is a sum of the final-turn records exposed by the harness, not an independently verified account charge; tool-call intermediate model messages may not be represented by those final-turn fields. The tool cases each required an internal model continuation, keeping the original smoke at about seven chat-completion rounds plus the `/models` authentication request.

A final production-path probe then used `PI_CODING_AGENT_DIR` plus `DEEPSEEK_API_KEY` and an unmodified default `PiSessionRunner`, without runtime injection. It resolved and checked `deepseek/deepseek-flash` at `https://api.deepseek.com` before sending the request, performed one fresh `material_read` loop, recorded exactly one tool call and coverage of `probe.txt`, and returned the expected fixed token. Its final assistant message reported 181 input tokens, 22 output tokens, and USD 0.000083772. This probe used two chat-completion rounds at most.

The private run artifacts are under `.agent/private/deepseek/smoke-2026-09-20T08-07-42-990Z/` and are excluded from Git.

## Reuse

- Repeat the billable smoke explicitly: `npm run deepseek:smoke`.
- Start the repository-local Pi CLI with the isolated profile: `npm run deepseek:local -- pi -e ./extensions/research.ts`. The launcher selects `deepseek/deepseek-flash` when neither `--model` nor `--provider` is supplied; an explicit Pi model/provider argument overrides that default.
- Start the project harness with the isolated profile: `npm run deepseek:local -- harness <command> [arguments...]`.

The smoke script is intentionally absent from `npm test`; tests remain offline. No formal research stages, model-routing defaults, workflow-improvement loop, detached jobs, or RSI behavior were added.

The retained script stops immediately on a failed check, caps the suite at one `/models` request plus seven model rounds, and applies a hard deadline to every scenario. Its logs contain boolean assertions and usage only; raw assistant text and raw provider errors are not printed. Cancellation wiring is covered by the existing offline runner tests; a deliberately billable live cancellation request was not added to this basic smoke.

## Verification

The repository-bundled TypeScript compiler completed `--noEmit -p tsconfig.json` successfully. `npm test` completed with 97 passing and zero failing tests. No dependency installation was attempted.

After the live test, `npm run deepseek:local -- pi -e ./extensions/research.ts --list-models deepseek` verified the real extension entrypoint and reusable launcher's default Pi profile discovery offline. It resolved `deepseek-flash` with a 1M context window, 384K model output capacity, thinking, and images. The final launcher profile intentionally has no smoke output cap; the 768-token override belongs only to the manual smoke profile.
