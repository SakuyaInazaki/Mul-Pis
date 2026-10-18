/** Declarative review and delivery specs.
 *
 * A review or delivery task used to exist only as a TypeScript object built at
 * a call site, so adding one meant editing code and no two callers had to agree
 * on the same fields. A spec is one JSON file that the harness validates and
 * maps onto the existing stage options, plus the provenance the review basis
 * asks a spec to carry: where the material came from and how strong its oracle
 * is. The harness never infers a missing field and never weakens a stage gate:
 * a spec selects and documents work, it does not grant anything. */
import { readFile } from "node:fs/promises";
import { HarnessError } from "./types.ts";
import type { M08Options } from "./stages/m08.ts";
import type { M09Options } from "./stages/m09.ts";

/** How much an independent check can actually decide. Declared, not derived:
 * the basis reports suites where only 8% of specs had a usable oracle, so a
 * weak one has to be visible in the record rather than assumed away. */
export type OracleStrength = "strong" | "medium" | "weak" | "none";

export interface StageSpecProvenanceV1 {
	oracleStrength: OracleStrength;
	/** Where the material and its reference answers come from. */
	source: string;
	/** Licence or usage limits of that source, when it has any. */
	license?: string;
	notes?: string;
}

export interface M08StageSpecV1 {
	version: 1;
	stage: "M08";
	provenance: StageSpecProvenanceV1;
	materials: M08Options["materials"];
	selfChecks: M08Options["selfChecks"];
	reviewers: M08Options["reviewers"];
	unprovidedScopes?: string[];
	previousRunId?: string;
	changeSummary?: string;
	affectedScope?: string;
}

export interface M09StageSpecV1 {
	version: 1;
	stage: "M09";
	provenance: StageSpecProvenanceV1;
	m08RunId: string;
	m04RunId: string;
	recipient: string;
	purpose: string;
	deliveryScope?: M09Options["deliveryScope"];
	reproduction?: M09Options["reproduction"];
	closureRequested?: boolean;
}

export type StageSpecV1 = M08StageSpecV1 | M09StageSpecV1;

const object = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

function provenance(value: unknown): StageSpecProvenanceV1 {
	if (!object(value) || !["strong", "medium", "weak", "none"].includes(String(value.oracleStrength)) ||
		typeof value.source !== "string" || !value.source.trim() || value.source.length > 1000 ||
		Object.keys(value).some(key => !["oracleStrength", "source", "license", "notes"].includes(key)) ||
		[value.license, value.notes].some(item => item !== undefined && (typeof item !== "string" || !item.trim() || item.length > 1000)))
		throw new HarnessError("stage.spec", "spec.provenance needs oracleStrength (strong|medium|weak|none) and a nonempty source; license and notes are optional strings");
	return { oracleStrength: value.oracleStrength as OracleStrength, source: value.source.trim(),
		...(typeof value.license === "string" ? { license: value.license.trim() } : {}),
		...(typeof value.notes === "string" ? { notes: value.notes.trim() } : {}) };
}

const text = (value: unknown, label: string, max = 400): string => {
	if (typeof value !== "string" || !value.trim() || value.length > max)
		throw new HarnessError("stage.spec", `${label} must be a nonempty string of at most ${max} characters`);
	return value.trim();
};

/** Parse one declarative spec. Stage-specific option shapes are validated by
 * the stages themselves; this checks the envelope and the fields a spec owns. */
export function parseStageSpec(value: unknown): StageSpecV1 {
	if (!object(value) || value.version !== 1 || !["M08", "M09"].includes(String(value.stage)))
		throw new HarnessError("stage.spec", "a stage spec needs version 1 and stage M08 or M09");
	const declared = provenance(value.provenance);
	if (value.stage === "M08") {
		const known = ["version", "stage", "provenance", "materials", "selfChecks", "reviewers",
			"unprovidedScopes", "previousRunId", "changeSummary", "affectedScope"];
		const unknown = Object.keys(value).filter(key => !known.includes(key));
		if (unknown.length) throw new HarnessError("stage.spec", `M08 spec has unknown fields: ${unknown.join(", ")}`);
		if (!Array.isArray(value.materials) || !value.materials.length || !Array.isArray(value.selfChecks) ||
			!value.selfChecks.length || !Array.isArray(value.reviewers) || !value.reviewers.length)
			throw new HarnessError("stage.spec", "an M08 spec needs nonempty materials, selfChecks and reviewers");
		if (value.unprovidedScopes !== undefined && (!Array.isArray(value.unprovidedScopes) ||
			value.unprovidedScopes.some(item => typeof item !== "string" || !item.trim())))
			throw new HarnessError("stage.spec", "unprovidedScopes must be nonempty strings");
		return { version: 1, stage: "M08", provenance: declared,
			materials: value.materials as M08Options["materials"],
			selfChecks: value.selfChecks as M08Options["selfChecks"],
			reviewers: value.reviewers as M08Options["reviewers"],
			...(value.unprovidedScopes ? { unprovidedScopes: value.unprovidedScopes as string[] } : {}),
			...(value.previousRunId === undefined ? {} : { previousRunId: text(value.previousRunId, "previousRunId") }),
			...(value.changeSummary === undefined ? {} : { changeSummary: text(value.changeSummary, "changeSummary", 2000) }),
			...(value.affectedScope === undefined ? {} : { affectedScope: text(value.affectedScope, "affectedScope", 2000) }) };
	}
	const known = ["version", "stage", "provenance", "m08RunId", "m04RunId", "recipient", "purpose",
		"deliveryScope", "reproduction", "closureRequested"];
	const unknown = Object.keys(value).filter(key => !known.includes(key));
	if (unknown.length) throw new HarnessError("stage.spec", `M09 spec has unknown fields: ${unknown.join(", ")}`);
	if (value.closureRequested !== undefined && typeof value.closureRequested !== "boolean")
		throw new HarnessError("stage.spec", "closureRequested must be a boolean");
	return { version: 1, stage: "M09", provenance: declared,
		m08RunId: text(value.m08RunId, "m08RunId"), m04RunId: text(value.m04RunId, "m04RunId"),
		recipient: text(value.recipient, "recipient"), purpose: text(value.purpose, "purpose", 2000),
		...(value.deliveryScope === undefined ? {} : { deliveryScope: value.deliveryScope as M09Options["deliveryScope"] }),
		...(value.reproduction === undefined ? {} : { reproduction: value.reproduction as M09Options["reproduction"] }),
		...(value.closureRequested === undefined ? {} : { closureRequested: value.closureRequested }) };
}

export async function loadStageSpec(file: string, stage: "M08" | "M09"): Promise<StageSpecV1> {
	let parsed: unknown;
	try { parsed = JSON.parse(await readFile(file, "utf8")); }
	catch (error) { throw new HarnessError("stage.spec", `${file} is not a readable JSON spec: ${(error as Error).message}`); }
	const spec = parseStageSpec(parsed);
	if (spec.stage !== stage) throw new HarnessError("stage.spec", `${file} declares stage ${spec.stage}, not ${stage}`);
	return spec;
}

/** One line for the operator's console: a weak oracle has to stay visible. */
export function stageSpecNotice(spec: StageSpecV1): string {
	return `规格来源：${spec.provenance.source}${spec.provenance.license ? `（许可：${spec.provenance.license}）` : ""}；oracle 强度：${spec.provenance.oracleStrength}${["weak", "none"].includes(spec.provenance.oracleStrength) ? "——独立检查的结论强度受限，报告中必须标注" : ""}。`;
}
