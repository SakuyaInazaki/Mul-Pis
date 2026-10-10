# Regression coverage for local-only execution

The local Python suite exposed a stale assertion requiring the provider probe
workflow to omit manual dispatch. That assertion encoded the previous push-only
request mechanism and contradicted the owner's current no-automatic-CI policy.

Updated the assertion to require manual dispatch while preserving all existing
fee and quota checks. Added a repository-wide check of every workflow event block:
only explicit manual dispatch is accepted. This test reads configuration locally;
it neither starts GitHub Actions nor authorizes a manual run.

Initial verification found one failure among 21 transport tests. After the fix,
all 22 transport tests, 4 browser-task tests, and 9 browser-artifact tests passed
locally under umask 022, for 35 Python tests total. No experiment material is included.
