# Resume trigger for bounded private campaign (2026-10-05)

The read-only DeepSeek authentication check completed successfully before this change. The bounded private campaign workflow gains a single push-message trigger on its existing branch while preserving the separate manual dispatch checkbox and account guard. The one-use marker is `mul-pis-20261005-lab-resume1`. This change does not modify the model, driver, input handling, private-result encryption, or the 23 CNY per-run planning ceiling. Earlier attempts retain 6.190624 CNY in separate conservative reservations; adding this campaign's full ceiling gives 29.190624 CNY, below the user's 30 CNY total ceiling. A reservation is not an invoice or proof that a provider accepted a request.

Deletion target: `.github/workflows/auth-check-once.yml`. It served the completed one-time authentication check and is removed so a future push does not keep carrying an obsolete auth-only workflow. It is recoverable from Git history at the prior published commit. No key material, private lab input, or result is added to the public repository.

The persisted local output private key was checked against the published public key and the workflow's pinned public-key fingerprint without printing key contents or including the key in this change. No campaign was launched in this preparation batch.

Focused workflow guard parsing, private transport unit tests, Node script syntax, and diff checks passed. This restored checkout had no installed Node dependencies, so local TypeScript typecheck could not be run without a network installation; the workflow performs typecheck before it decodes private input or dispatches a model request.
