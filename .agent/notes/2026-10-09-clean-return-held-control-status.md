# Keep held mission status visible on CLI return

The first full Node aggregate on `d4d8672` exposed a composed CLI failure. A fresh-process resume correctly retained a synthetic UNKNOWN operation, but the new clean-return path still attempted to finalize that non-quiescent attempt. The host refused the final receipt, and `mission resume` threw `local.mission.release-held` before printing its recorded `execution-interrupted` status.

The CLI adapter now leaves ownership held when the returned checkpoint already records an unresolved operation or a pending M04 review. It emits the existing structured control result; the CLI exits nonzero for `execution-interrupted`. Other clean-return refusals still throw, and the final receipt still requires the host's full quiescence check. The regression requires the nonzero exit and verifies the UNKNOWN operation, checkpoint, and prior M07/M04 counts without replay.

The frozen `d4d8672` aggregate was Node 1559/1560 with this sole failure, Python 35/35, and direct TypeScript pass. The focused fresh-process regression and direct TypeScript check passed after the change. A complete offline aggregate for the new exact tree is pending. The supplied lab mission and its private records were not modified by this source repair.
