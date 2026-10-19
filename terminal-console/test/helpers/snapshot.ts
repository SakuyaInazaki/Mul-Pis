/** Shared console test fixtures. Keeping the empty audit in one place means a
 * new audit field does not have to be pasted into every snapshot literal. */
import { buildWorkflowAudit } from "../../src/console/audit.ts";
import type { WorkflowAuditV1 } from "../../src/console/model.ts";

export function emptyAudit(generatedAt = "2026-10-14T00:00:00Z"): WorkflowAuditV1 {
	return buildWorkflowAudit([], [], generatedAt);
}
