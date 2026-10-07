# Recovered private transport diagnostics

The private campaign driver now drains each session handle's redacted transport diagnostics after every prompt, whether the prompt returns or throws. The per-handle cursor prevents a diagnostic from being counted again on later prompts. This preserves the known cause of a rejected provider request when Pi retries it and the prompt succeeds, so private status and the encrypted transport census can include that cause. The wrapper adds no public logging.

A synthetic offline test covers a successful prompt that exposes a recovered diagnostic followed by another successful prompt with no duplicate. The private campaign test file and TypeScript typecheck pass. No provider calls were made.

The driver also classifies stage failures against the current V3 request audit. A diagnostic for a request with a later separately reserved `retryOfRequestId` successor is a recovered rejection and does not by itself select a transport retry pending action. A diagnostic on the final failed retry remains an unrecovered transport failure. The focused regression covers both cases; all 49 private campaign tests and typecheck pass.
