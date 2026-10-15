# M04 checkpoint independent-review coverage

M04 previously enforced full `m07_evidence_read` coverage only for caller-supplied `requiredM07ReadPaths`. A selected M07 task could carry a frozen `review.independentCheck.report` in its checkpoint while M04 judged the candidate without receiving that report in full.

For a selected checkpoint, M04 now derives independent-check report paths from the frozen goal, requires each path to occur in the already validated checkpoint manifest, and adds them to the existing full-read gate. Caller-supplied required paths remain in that gate. Omitted tasks contribute no new read obligation. The existing repair loop asks for missing ranges before accepting a judgment or knowledge proposal.

The M04 checkpoint test now covers a selected candidate whose check task is omitted from the checkpoint task selection: the candidate report is returned first, the missing independent report is requested again, and M04 completes after its full return. Test execution belongs to the coordinated repository test pass.
