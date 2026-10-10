# Private campaign trigger cleanup

The one-use push trigger for the bounded confidential campaign has been removed after its scheduled validation run. The workflow now accepts only manual dispatch on the specified repository, account, and branch, on the first attempt, with `authorize_bounded_run` explicitly set to true. The input defaults to false. The 5.3 CNY text remains the current per-run planning ceiling; any future manual run needs separate cumulative budget accounting and authorization before dispatch. This cleanup makes no model request and contains no private task input or result.

Offline verification: `node --test test/manual-private-campaign.test.ts`, `npm run typecheck`, and `git diff --check`.
