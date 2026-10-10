/** The stored experience shape shared by proposal validation and consumers. */
import type { KnowledgeRef } from "./types.ts";

export type ExperienceTargetKind = "executor" | "improver";

export interface ExperienceDefinition {
	version: 1;
	targetKind: ExperienceTargetKind;
	applicableStages: string[];
	requiredTags: string[];
	excludedTags: string[];
	requiredRefs: KnowledgeRef[];
}

const recordIdPattern = /^[CKEJQDX]\d{3,}$/;
const storeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isStrings = (value: unknown, maxLength: number): value is string[] =>
	Array.isArray(value) && value.every((item) =>
		typeof item === "string" && !!item.trim() && item.length <= maxLength);

export function isKnowledgeRef(value: unknown): value is KnowledgeRef {
	return isObject(value) && typeof value.storeId === "string" && storeIdPattern.test(value.storeId) &&
		typeof value.recordId === "string" && recordIdPattern.test(value.recordId) &&
		Number.isSafeInteger(value.version) && (value.version as number) > 0;
}

/** All issue text is bounded and excludes user supplied field values. */
export function validateExperienceDefinition(value: unknown): { definition?: ExperienceDefinition; issues: string[] } {
	const issues: string[] = [];
	if (!isObject(value)) return { issues: ["fields.experience must be an object with version, targetKind, applicableStages, requiredTags, excludedTags, and requiredRefs"] };
	if (value.version !== 1) issues.push("fields.experience.version must be 1");
	if (value.targetKind !== "executor" && value.targetKind !== "improver")
		issues.push('fields.experience.targetKind must be "executor" or "improver"');
	if (!isStrings(value.applicableStages, 80))
		issues.push("fields.experience.applicableStages must be an array of nonempty strings, each at most 80 characters");
	for (const key of ["requiredTags", "excludedTags"] as const) {
		if (!isStrings(value[key], 240))
			issues.push(`fields.experience.${key} must be an array of nonempty strings, each at most 240 characters`);
	}
	if (!Array.isArray(value.requiredRefs)) {
		issues.push("fields.experience.requiredRefs must be an array of pinned {storeId,recordId,version} objects; an empty array is valid");
	} else {
		for (const [index, ref] of value.requiredRefs.entries()) {
			const prefix = `fields.experience.requiredRefs[${index}]`;
			if (!isObject(ref)) {
				issues.push(`${prefix} must be a pinned {storeId,recordId,version} object; strings such as K001@1 are invalid`);
				continue;
			}
			if (Object.keys(ref).some(key => key !== "storeId" && key !== "recordId" && key !== "version"))
				issues.push(`${prefix} must contain only {storeId,recordId,version}; extra keys are invalid`);
			if (typeof ref.storeId !== "string" || !storeIdPattern.test(ref.storeId))
				issues.push(`${prefix}.storeId must be a store UUID`);
			if (typeof ref.recordId !== "string" || !recordIdPattern.test(ref.recordId))
				issues.push(`${prefix}.recordId must be a knowledge record ID such as K001`);
			if (!Number.isSafeInteger(ref.version) || (ref.version as number) <= 0)
				issues.push(`${prefix}.version must be a positive integer`);
		}
	}
	return issues.length ? { issues } : { definition: value as unknown as ExperienceDefinition, issues };
}
