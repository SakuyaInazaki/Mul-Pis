# Private resume preparation: classified host refusals

The reusable host bridge now records fixed, structured refusal codes in its
mode-0600 private diagnostic when the tested source has a CI run still pending,
a completed run without success, or no matching run. Other fixed adapter
refusals carry their verification stage; an unsuccessful GitHub read also
retains its HTTP status. The public process output remains generic and does
not include the private mission decision, input files, credentials, or result.

A pending CI run still blocks request preparation. When CI succeeds, normal
authenticated preparation and the existing journal checks apply. This change
does not dispatch or retry a control request and does not change the research
workflow's scientific decisions.

Synthetic checks cover pending, failed and absent CI, private diagnostic
structure, no journal reservation on refusal, the STDIO bridge, and
TypeScript typechecking. The bridge's local file-reference type guard was
made property-preserving so the entire CLI module is typechecked when imported
by the new regression.
