# Offline DeepSeek auth transport regression (2026-10-04)

Added an offline integration test that creates a fresh Pi session with audited file tools and an in-memory synthetic API key. Its HTTP transport is replaced with a fixed fake response, while the global fetch path is trapped against accidental network fallback. The test checks only booleans: the request reaches the configured DeepSeek chat endpoint, carries the synthetic key in the Authorization header, includes the tool grant, and is reserved once by the campaign budget. No real credential or private input is read, and no external request is made.

The focused runner tests (8 cases), full offline suite (361 tests), typecheck, and diff check passed. This does not validate any live account key or provider response.
