# Record source actions after completion and correct malformed builder handoffs

Source-search actions previously appeared as completed on disk before their asynchronous model, build, or evaluation operation returned. They now start as pending and change to completed or failed when the operation settles. The existing serial execution and selection checks remain in place.

The source builder required a structured hypothesis but described that response format as optional. Its prompt now states the actual format contract. One invalid format or field response is returned to the same model session for correction; both original and corrected responses, the full tool log, and cumulative usage are retained. A second invalid response, provider failure, or cancellation remains a rejected candidate. The parser, editable source files, engineering checks, research comparison rules, and model configuration are unchanged.

Source-search and meta protocol fixtures now write their own fixed I program before preparing the test source. They no longer copy the evolvable runtime strategy and then require it to keep a fixed action order or model-call count. The fixtures were independently checked with a deliberately throwing runtime I to confirm this separation.

Offline regressions exercise suspended asynchronous actions and a malformed hypothesis followed by same-session correction and a real local Git candidate commit. Failure and cancellation cases preserve the known usage and unknown tail. The patches were applied after the frozen experiment terminated. The two source repairs passed typecheck and the full isolated offline suite (1642 passed, 16 skipped, zero failures); the independent test fixtures passed their targeted checks including the throwing-runtime-I probe. The final combined source worktree passed typecheck and the complete offline suite: 1658 tests, 1642 passed, 16 skipped, zero failures and cancellations.

The research summary now records the completed second I development run, its settled usage, actual source/branch execution, and indeterminate scientific comparison. Only aggregate reviewed findings are included; raw experiment material remains local.
