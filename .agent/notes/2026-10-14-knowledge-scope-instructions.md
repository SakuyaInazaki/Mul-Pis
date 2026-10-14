# Clarify the existing knowledge context-reference format

Real M04 execution exposed a mismatch between the proposal instructions and the existing validator: the instructions showed an empty scope array but did not explain that populated entries refer to X context records. Models used scientific scope labels and then a default-context label, causing repeated same-session corrections before their proposals could merge.

The shared knowledge proposal instructions now explain existing X ID/version references, earlier X handles, and the empty-array default. Scientific scope descriptions remain in the record body or fields. Omitted revise fields retain their existing values. No validator, proposal, scientific decision, or historical result is changed by this clarification.

The observed batch completed all eight M04 transactions through the existing repair path; seven first proposals and four second proposals needed this format correction. These counts describe the observed prompt mismatch, not a claim that new wording has already been verified with a new real model run.
