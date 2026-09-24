# M05 acquisition coverage integration

- Extended M05 search calls with provider selection, page/cursor/site continuation and scoped failure records; added Crossref and GitHub Issues discovery and retained Hacker News discussion URLs alongside primary links.
- Added paginated inspection of saved page links plus segmented work-file reads and direct image inspection, so truncated tool output and screenshots can be recovered without treating unseen content as reviewed.
- Made interactive browsing available whenever configured and useful for the task. The adapter saves changed DOM, extracted text, screenshots, visited URLs and downloads incrementally within the same fresh headless browser session; partial artifacts, warnings and errors survive task failure where capture succeeded.
- Kept the browser model report separate from source material. It cannot be registered as an original source; only contained material artifacts can be registered, with per-file URL/title/time/content-type/kind or derivation facts preserved.
- Added explicit capture limits and warnings and strengthened acquisition instructions around task-scoped coverage, discussion context, attachments, and planned/obtained/missing ranges. The implementation does not claim blanket completeness, automatic all-post forum capture, existing-user-session/login integration, or universal website support.
- Updated README, implementation design, workflow-foundation M05 alignment, M05 tool record, documentation index, Python adapter README, and the minimal AGENTS implementation status to match the code and authorized boundary. The README now distinguishes the selected Pi SDK controller from the still-undecided M07 extension/RSI architecture. The original workflow and third-party provenance were not changed.

Final offline verification reported by the integration agent:

- Bundled TypeScript check exited 0 with no diagnostics.
- `npm test` passed all 44 tests in 8 suites, with no skipped tests.
- The consolidated Python browser-artifact/fetch-page suite passed all 5 tests; Python compilation also passed.
- `git diff --check` exited 0.
- The simulated public file list contained 108 files and excluded `resources/`, `third_party/`, `.agent/private/`, and nested `.git` directories.
- The changed-file scan found no machine-specific paths or credentials.

No real cloud-model end-to-end run has been performed; the results above validate the offline implementation and packaging boundary only.

Independent review found and the final implementation corrected one residual case: an HTTP 4xx HTML response is still saved as HTML/markdown for diagnosis, but now carries an HTTP error and warning and never claims that target-page link extraction is complete. Offline regressions cover 403, 404, and 429 responses through the TypeScript HTTP path and both Python HTTP/Crawl4AI paths.

No network/model calls, dependency installation, model routing, paid-content access, commit, push, or release operation was performed as part of this documentation batch.
