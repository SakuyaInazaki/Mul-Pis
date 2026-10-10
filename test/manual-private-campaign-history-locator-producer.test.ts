import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { offlineChecks } from "../scripts/manual-private-campaign.ts";

test("split history catalog advertises superseded artifacts and points to their raw entry", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-history-old-locator-"));
	try {
		const oldNames = ["old-review.md", "old-z.txt", "old-feedback.json", "old-y.txt",
			"old-lesson.md", "old-x.txt", "old-w.txt", "old-v.txt", "old-u.txt", "old-t.txt"];
		const currentNames = ["current-z.txt", "current-review.md", "current-feedback.json",
			"current-lesson.md", "current-b.txt", "current-a.txt"];
		const rawOldLesson = "RAW_OLD_LESSON_ONLY:" + "L".repeat(1_100_000);
		const oldFiles = Object.fromEntries(oldNames.map(name => [name,
			name === "old-lesson.md" ? rawOldLesson : `raw ${name}`]));
		const currentFiles = Object.fromEntries(currentNames.map(name => [name, `current ${name}`]));
		const target = { goalRunId: "R001", taskId: "T001", files: currentFiles,
			supersededVersions: [{ interpretation: "prior attempt", files: oldFiles }] };
		const filler = Array.from({ length: 5_000 }, (_, index) => ({
			goalRunId: `G${index + 2}`, taskId: "T002",
			files: { [`filler-${index}-${"n".repeat(150)}.txt`]: "x" },
		}));
		const hostOnlyValues = ["HOST_ONLY_SOURCE_DO_NOT_STAGE", "HOST_ONLY_RUN_DO_NOT_STAGE",
			"HOST_ONLY_DIGEST_DO_NOT_STAGE"];
		const history = JSON.stringify({ version: 1, kind: "untrusted-version-bound-research-history",
			entries: [target, ...filler], predecessorHistoryReconciliation: {
				source: hostOnlyValues[0], runId: hostOnlyValues[1], digest: hostOnlyValues[2],
			} });
		const originalHistory = history;
		const staged = await offlineChecks.stageRangeReadableHistory(root, history);
		assert.equal(history, originalHistory);
		assert.deepEqual(Object.values(JSON.parse(history).predecessorHistoryReconciliation),
			hostOnlyValues);
		const stagedTexts = await Promise.all(staged.evidence.map(item => readFile(item.file, "utf8")));
		for (const value of hostOnlyValues) assert.ok(stagedTexts.every(text => !text.includes(value)));
		assert.equal(staged.partitioned, true);
		const indexText = await readFile(path.join(root, "prior-research-history-index.json"), "utf8");
		const index = JSON.parse(indexText) as {
			entries: unknown[]; catalogParts: Array<{ name: string }>; parts: Array<{ name: string; bytes: number }>;
		};
		assert.equal(index.entries.length, 0);
		assert.ok(index.catalogParts.length > 1);
		assert.ok((await stat(path.join(root, "prior-research-history-index.json"))).size <= 1_000_000);
		const catalogTexts = await Promise.all(index.catalogParts.map(async ({ name }) => {
			assert.ok((await stat(path.join(root, name))).size <= 1_000_000);
			return readFile(path.join(root, name), "utf8");
		}));
		assert.ok(!indexText.includes("RAW_OLD_LESSON_ONLY:"));
		assert.ok(catalogTexts.every(text => !text.includes("RAW_OLD_LESSON_ONLY:")));
		const entries = catalogTexts.flatMap(text => JSON.parse(text).entries as Array<{
			entryOrdinal: number; fileNames: string[]; supersededVersionCount: number;
			supersededVersions: Array<{ versionOrdinal: number; fileNames: string[] }>;
			parts: Array<{ name: string; startByte: number; endByte: number;
				startLine: number; endLine: number }>;
		}>);
		const locator = entries.find(row => row.entryOrdinal === 0);
		assert.ok(locator);
		assert.deepEqual(locator.fileNames, currentNames);
		assert.equal(locator.supersededVersionCount, 1);
		assert.deepEqual(locator.supersededVersions, [
			{ versionOrdinal: 0, fileNames: [...oldNames].sort() },
		]);
		assert.ok(locator.parts.length > 1);
		const indexedPartNames = new Set(index.parts.map(part => part.name));
		const rawEntry = Buffer.concat(await Promise.all(locator.parts.map(async range => {
			assert.ok(indexedPartNames.has(range.name));
			assert.ok(range.startLine >= 1 && range.endLine >= range.startLine);
			const bytes = await readFile(path.join(root, range.name));
			assert.ok(range.startByte >= 0 && range.endByte <= bytes.length);
			return bytes.subarray(range.startByte, range.endByte);
		})));
		const parsed = JSON.parse(rawEntry.toString("utf8"));
		assert.equal(parsed.supersededVersions[0].files["old-lesson.md"], rawOldLesson);
		assert.equal(parsed.supersededVersions[0].files["old-review.md"], oldFiles["old-review.md"]);
		assert.equal(parsed.supersededVersions[0].files["old-feedback.json"], oldFiles["old-feedback.json"]);
		assert.deepEqual(Object.keys(parsed.files), currentNames);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
