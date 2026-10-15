# M07 independent-check artifact ordering

M07 review now collects declared expected outputs and lesson evidence before applying the existing independent-check byte and binary-read checks. Previously, review checked only caller-listed artifacts and could then add an unchecked declared output to an accepted review. No task schema, acceptance criterion, M04 judgment, or checkpoint selection rule changed.

Added one offline regression covering a report-only check that must reject an additional declared source artifact, followed by a check that receives both artifacts and can accept. `npm run typecheck` and the M07 offline test file passed (47/47); the test needs host process-identity access to read the boot time in this environment. No model, network, or research experiment was run.
