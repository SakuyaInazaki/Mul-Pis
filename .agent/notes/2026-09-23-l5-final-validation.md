# L5 bounded experiment final offline validation

The source/test owners froze their changes before the final serial validation. No real model or network experiment was run during these checks. The earlier two live development segments remain recorded only in ignored private pilot and batch-ledger files.

The first full `npm run typecheck` found one test-only TypeScript mismatch: a new dependency test supplied an async Fake reply to a helper typed for a synchronous reply. The knowledge owner widened the test fixture type without changing behavior. The subsequent full `npm run typecheck` passed. The executable was the repository-local `node_modules/.bin/tsc`, resolving to the ignored local Pi checkout's TypeScript 5.9.3, not an external PATH compiler. Node was v26.3.0.

The serial `npm test` run discovered 214 tests: 211 passed; three dashboard tests were blocked solely by sandbox `listen EPERM` on `127.0.0.1`. The three affected tests were rerun by normal permission escalation as `node --test test/dashboard-server.test.ts`; all three passed. Effective final result: 214/214 verified passing, with a loopback sandbox exception requiring the narrow rerun. No tests were rewritten to work around the environment.

`git diff --check` passed. The public tree contains source, tests, documentation, and configuration changes only; untracked public files total about 196 KB, with no large generated artifact. `.agent/private/`, `.agent/notes/`, `.agent/telemetry/`, `workspaces/`, and local `third_party/` contents remain ignored. A read-only process-table check under normal permission escalation found no lingering `l5-i-one.ts` or Node test commands. No `git add`, commit, or push was performed in this validation step.
