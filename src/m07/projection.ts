import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import type { StageContext } from "../stages/context.ts";
import type { CurrentGoal } from "./types.ts";
import type { BudgetPolicy } from "../improvement/policy.ts";
import { capturedRunBytes, newProjectionEvent, nextProjectionOrdinal, type ProjectionEventV1, type ProjectionMaterialV1, type ProjectionSnapshotLimits } from "../improvement/observations.ts";

interface TextInventory { text?: string; chars: number; bytes: number; path: string }

/** Count UTF-8 bytes and decoded UTF-16 units without retaining deferred text. */
async function textInventory(source: string, displayPath: string, retainThroughChars: number): Promise<TextInventory> {
	const decoder = new StringDecoder("utf8");
	let chars = 0, bytes = 0;
	let retained: string[] | undefined = [];
	const accept = (text: string) => {
		chars += text.length;
		if (retained && chars <= retainThroughChars) retained.push(text);
		else retained = undefined;
	};
	for await (const chunk of createReadStream(source)) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		accept(decoder.write(buffer));
	}
	accept(decoder.end());
	return { text: retained?.join(""), chars, bytes, path: displayPath };
}

class SnapshotBudgetExceeded extends Error {}

export async function copySnapshotBounded(source: string, snapshot: string, maxBytes: number): Promise<number> {
	await mkdir(path.dirname(snapshot), { recursive: true });
	let copied = 0;
	try {
		await pipeline(createReadStream(source), new Transform({ transform(chunk: Buffer, _encoding, callback) {
			copied += chunk.length;
			callback(copied > maxBytes ? new SnapshotBudgetExceeded("projection snapshot budget exceeded") : null, copied > maxBytes ? undefined : chunk);
		} }), createWriteStream(snapshot, { flags: "wx" }));
		return copied;
	} catch (error) {
		await unlink(snapshot).catch(() => undefined);
		throw error;
	}
}

export function omissionLine(item: { chars: number; bytes: number; path: string }, shown: number): string {
	const shownRange = shown > 0 ? `1–${shown}` : "无（0 字符）";
	const unreadRange = shown < item.chars ? `${shown + 1}–${item.chars}` : "无";
	return `- ${item.path}；${item.bytes} bytes / ${item.chars} 字符；已显示字符 ${shownRange}；未显示字符 ${unreadRange}；原文完整保留，可用只读工具按需读取。`;
}

export function projectionMaterial(ctx: StageContext, event: ProjectionEventV1, ordinal: number, role: ProjectionMaterialV1["role"], source: string, type: "text" | "binary"): ProjectionMaterialV1 {
	const snapshotPath = path.join("projection-materials", event.eventId, `${String(ordinal + 1).padStart(3, "0")}-${path.basename(source)}`);
	return { ordinal, role, mediaType: type, sourcePath: path.relative(ctx.ws.root, source), snapshotPath, availability: "available", snapshotStatus: "unavailable", laterReadVersion: "unknown", decision: type === "binary" ? "binary" : "unavailable" };
}

export async function captureMaterial(ctx: StageContext, event: ProjectionEventV1, material: ProjectionMaterialV1, source: string, retainThroughChars: number): Promise<TextInventory | undefined> {
	const snapshot = path.join(ctx.ws.runDir("M07", event.m07RunId), material.snapshotPath!);
	try {
		const sourceInfo = await stat(source);
		const budget = event.captureBudget;
		const remainingCall = Math.max(0, budget.perCallBytes - budget.usedCallBytes);
		const remainingRun = Math.max(0, budget.perRunBytes - budget.usedRunBytesAtStart - budget.usedCallBytes);
		const cap = Math.min(budget.perMaterialBytes, remainingCall, remainingRun);
		const reason: ProjectionMaterialV1["captureReason"] = sourceInfo.size > budget.perMaterialBytes ? "per-material" : sourceInfo.size > remainingCall ? "per-call" : "per-run";
		if (sourceInfo.size > cap) {
			material.snapshotStatus = "budget-exceeded";
			material.captureReason = reason;
			material.snapshotPath = undefined;
			material.utf8Bytes = sourceInfo.size;
			if (material.mediaType === "binary") return undefined;
			const inventory = await textInventory(source, material.sourcePath, retainThroughChars);
			material.utf8Bytes = inventory.bytes;
			material.utf16CodeUnits = inventory.chars;
			return inventory;
		}
		let captured = 0;
		try { captured = await copySnapshotBounded(source, snapshot, cap); }
		catch (error) {
			if (!(error instanceof SnapshotBudgetExceeded)) throw error;
			material.snapshotStatus = "budget-exceeded";
			material.captureReason = cap === budget.perMaterialBytes ? "per-material" : cap === remainingCall ? "per-call" : "per-run";
			material.snapshotPath = undefined;
			if (material.mediaType === "binary") { material.utf8Bytes = (await stat(source)).size; return undefined; }
			const inventory = await textInventory(source, material.sourcePath, retainThroughChars);
			material.utf8Bytes = inventory.bytes;
			material.utf16CodeUnits = inventory.chars;
			return inventory;
		}
		budget.usedCallBytes += captured;
		material.snapshotStatus = "captured";
		material.utf8Bytes = captured;
		material.snapshotMtimeMs = (await stat(snapshot)).mtimeMs;
		if (material.mediaType === "binary") {
			return undefined;
		}
		const inventory = await textInventory(snapshot, material.sourcePath, retainThroughChars);
		material.utf8Bytes = inventory.bytes;
		material.utf16CodeUnits = inventory.chars;
		return inventory;
	} catch (error) {
		material.availability = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
		material.snapshotStatus = "unavailable";
		material.decision = "unavailable";
		material.reason = "unavailable";
		throw error;
	}
}

export async function createProjectionObservation(ctx: StageContext, goal: CurrentGoal, purpose: ProjectionEventV1["purpose"], policy: BudgetPolicy, limits: ProjectionSnapshotLimits, taskId?: string): Promise<ProjectionEventV1> {
	return newProjectionEvent({ callOrdinal: await nextProjectionOrdinal(ctx.ws, goal.runId), purpose, m07RunId: goal.runId, taskId, policyVersionId: goal.budgetPolicyVersionId!, policy, methodBinding: goal.methodBinding, tokenMeasurement: { unit: "provider-token", status: "unavailable" }, captureBudget: { ...limits, usedRunBytesAtStart: await capturedRunBytes(ctx.ws, goal.runId), usedCallBytes: 0 }, projectionStatus: "unavailable", deliveryStatus: "not-submitted", materials: [] });
}
