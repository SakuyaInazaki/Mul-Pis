# Clean Actions preflight fixtures

The browser artifact test previously invoked the ignored project `.venv`, which is absent from a clean GitHub Actions checkout. Its Python fixture uses only the standard library, so the test now runs with an explicitly selected `PYTHON` interpreter or `python3` from `PATH` while retaining all five offline assertions.

The M09 cancellation test's inline Node source previously nested unescaped double quotes in a shell double-quoted argument. The shell could strip the source path quotes and make Node exit with a syntax or reference error before cancellation. The test now shell-quotes the Node executable and source, waits for a child-created start marker, then aborts and verifies the saved null exit code, cancellation message, and absence of a delayed file write.

These changes are limited to offline test portability and verification. They do not run a research campaign or call a model provider.
