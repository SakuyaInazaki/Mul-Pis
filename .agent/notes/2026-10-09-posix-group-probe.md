# Portable foreground process-group observation

Managed local bash receipts now use the POSIX zero-signal process-group probe. `ESRCH` means the process group has no current member; success or `EPERM` means a member may remain. On Linux, a readable `/proc` scan can refine a positive signal result when only zombie members remain. If `/proc` cannot be scanned, the positive signal stays conservative. Unsupported signal errors remain unknown. This observation does not account for a child that changed process groups or any remote side effect, and it does not provide OS isolation.

Deterministic offline tests inject Darwin-style signal outcomes without `/proc` and Linux zombie, live-member, missing-proc and `ESRCH` outcomes. Existing Linux real-process tests still exercise the default runner path. Cross-platform integration on macOS and Windows remains untested here.
