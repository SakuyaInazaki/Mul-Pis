# Managed bash signal termination

The managed POSIX bash backend now throws a tool error when its foreground
process exits because of an independent signal. Pi treats `exitCode: null` as
success, so returning that value could present an interrupted command as a
successful empty result. The backend first drains the observed output and
durably records the actual exit signal and abort source. Its existing explicit
abort and timeout errors retain priority.

An offline regression starts a local command through the Pi bash tool,
observes its output, sends SIGTERM from the test process, and checks that the
tool fails while the receipt retains `exitCode: null`, `signal: SIGTERM`, and
`abortSource: none`. This test uses no model or network.
